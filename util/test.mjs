import * as esbuild from 'esbuild'
import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import http from 'http';
import path from 'path';
import postcss from 'postcss';
import postcssImport from 'postcss-import';
import postcssImportDev from '../postcss-import/index.js';
import postcssRebaseURL from '../postcss-rebase-url/index.mjs'
import { bundle as lightningcss } from 'lightningcss';

function hashLayerName(index, rootFilename) {
	if (!rootFilename) {
		return `import-anon-layer-${index}`;
	}

	// A stable, deterministic and unique layer name:
	// - layer index
	// - relative rootFilename to current working directory
	return `import-anon-layer-${crypto
		.createHash('sha256')
		.update(`${index}-${rootFilename}`)
		.digest('hex')
		.slice(0, 12)}`;
}


function html(bundle = 'native') {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Native</title>

	<style>
		@layer base {
			:where(.box) {
				width: 100px;
				height: 100px;
				background-color: red;
			}
		}
	</style>

	<link rel="stylesheet" href="style.css?bundle=${bundle}">
</head>
<body>
	<div id="box" class="box">
	</div>
</body>
</html>
`
}

export async function createTestSafe(browser, testPath) {
	try {
		const result = await createTest(browser, testPath);
		return {
			...result,
			label: testPath.slice(1).join('/'),
		}
	} catch (e) {
		return {
			label: testPath.slice(1).join('/'),
			bundlers: [],
			success: false,
			error: e,
		}
	}
}

export async function createTest(browser, testPath) {
	let errors = [];
	let pageError = null;
	let requestHandlerError = null;
	let serverError = null;

	let imageWasRequested = false;

	const resetState = () => {
		pageError = null;
		requestHandlerError = null;
		serverError = null;

		imageWasRequested = false;
	}

	const server = http.createServer(async (req, res) => {
		const parsedUrl = new URL(req.url, 'http://localhost:8080');
		const pathname = parsedUrl.pathname;
		const bundle = parsedUrl.searchParams.get('bundle');

		switch (pathname) {
			case '':
			case '/native.html':
				res.setHeader('Content-type', 'text/html');
				res.writeHead(200);
				res.end(html('native'));
				return;
			case '/csstools-postcss-bundle.html':
				res.setHeader('Content-type', 'text/html');
				res.writeHead(200);
				res.end(html('csstools-postcss-bundle'));
				return;
			case '/postcss-import.html':
				res.setHeader('Content-type', 'text/html');
				res.writeHead(200);
				res.end(html('postcss-import'));
				return;
			case '/lightningcss.html':
				res.setHeader('Content-type', 'text/html');
				res.writeHead(200);
				res.end(html('lightningcss'));
				return;
			case '/esbuild.html':
				res.setHeader('Content-type', 'text/html');
				res.writeHead(200);
				res.end(html('esbuild'));
				return;
			case '/style.css':
				res.setHeader('Content-type', 'text/css');
				res.writeHead(200);

				switch (bundle) {
					case 'native':
						res.end(await fs.readFile(path.join(...testPath, 'style.css'), 'utf8'));
						return;

					case 'csstools-postcss-bundle':
						await postcss([
							postcssImportDev({
								skipDuplicates: false,
								nameLayer: hashLayerName,
							}),
							postcssRebaseURL(),
						]).process(await fs.readFile(path.join(...testPath, 'style.css'), 'utf8'), {
							from: path.join(...testPath, 'style.css'),
							to: path.join(...testPath, 'style.css'),
						}).then((result) => {
							res.end(result.css);
						}).catch((e) => {
							requestHandlerError = e;
							errors.push(requestHandlerError);

							res.end('');
						});
						return;
					case 'postcss-import':
						await postcss([
							 postcssImportDev(),
						]).process(await fs.readFile(path.join(...testPath, 'style.css'), 'utf8'), {
							from: path.join(...testPath, 'style.css'),
							to: path.join(...testPath, 'style.css'),
						}).then((result) => {
							res.end(result.css);
						}).catch((e) => {
							requestHandlerError = e;
							errors.push(requestHandlerError);

							res.end('');
						});
						return;
					case 'lightningcss':
						try {
							let { code } = lightningcss({
								filename: path.join(...testPath, 'style.css'),
								minify: false
							});

							res.end(code);
						} catch (e) {
							requestHandlerError = e;
							errors.push(requestHandlerError);

							res.end('');
						}

						return;
					case 'esbuild':
						try {
							const esBundle = await esbuild.build({
								entryPoints: [path.join(...testPath, 'style.css')],
								bundle: true,
								logLevel: 'silent',
								write: false,
								external: ['*.png']
							})

							res.end(esBundle.outputFiles[0].text);
						} catch (e) {
							requestHandlerError = e;
							errors.push(requestHandlerError);

							res.end('');
						}

						return;
				}

				res.end('');
				return;

			default:
				if (pathname.endsWith('.css')) {
					if (fsSync.existsSync(path.join(...testPath, pathname.slice(1)))) {
						res.setHeader('Content-type', 'text/css');
						res.writeHead(200);
						res.end(await fs.readFile(path.join(...testPath, pathname.slice(1)), 'utf8'));
						return;
					}
				}

				if (pathname.endsWith('.png')) {
					if (fsSync.existsSync(path.join(...testPath, pathname.slice(1)))) {
						imageWasRequested = true;
						res.setHeader('Content-type', 'image/png');
						res.writeHead(200);
						res.end(await fs.readFile(path.join(...testPath, pathname.slice(1)), 'utf8'));
						return;
					}
				}

				res.setHeader('Content-type', 'text/plain');
				res.writeHead(404);
				res.end('Not found');
				break;
		}
	});

	server.timeout = 100;

	server.on('error', (e) => {
		serverError = e;
		errors.push(serverError);
	});

	server.listen(8080);

	const page = await browser.newPage();
	await page.setCacheEnabled(false);
	
	page.on('pageerror', (msg) => {
		pageError = new Error(msg);
		errors.push(pageError);
	});

	let results = {
		success: false,
		bundlers: []
	}

	{
		resetState();
		await page.goto(`http://localhost:8080/native.html`);
		const result = await page.evaluate(async () => {
			const box = document.getElementById('box');
			const style = window.getComputedStyle(box);
			return [style.backgroundColor, style.backgroundImage];
		});

		results.bundlers.push({
			label: 'native',
			success: (!serverError && !pageError && !requestHandlerError) && (
				result[0] === 'rgb(0, 128, 0)' ||
				(
					imageWasRequested && result[1].includes('/green.png')
				)
			),
			result: result,
		});
	}

	{
		resetState();
		await page.goto(`http://localhost:8080/csstools-postcss-bundle.html`);
		const result = await page.evaluate(async () => {
			const box = document.getElementById('box');
			const style = window.getComputedStyle(box);
			return [style.backgroundColor, style.backgroundImage];
		});

		results.bundlers.push({
			label: 'csstools-postcss-bundle',
			success: (!serverError && !pageError && !requestHandlerError) && (
				result[0] === 'rgb(0, 128, 0)' ||
				(
					imageWasRequested && result[1].includes('/green.png')
				)
			),
			result: result,
		});
	}

	{
		resetState();
		await page.goto(`http://localhost:8080/postcss-import.html`);
		const result = await page.evaluate(async () => {
			const box = document.getElementById('box');
			const style = window.getComputedStyle(box);
			return [style.backgroundColor, style.backgroundImage];
		});

		results.bundlers.push({
			label: 'postcss-import',
			success: (!serverError && !pageError && !requestHandlerError) && (
				result[0] === 'rgb(0, 128, 0)' ||
				(
					imageWasRequested && result[1].includes('/green.png')
				)
			),
			result: result,
		});
	}

	{
		resetState();
		await page.goto(`http://localhost:8080/lightningcss.html`);
		const result = await page.evaluate(async () => {
			const box = document.getElementById('box');
			const style = window.getComputedStyle(box);
			return [style.backgroundColor, style.backgroundImage];
		});

		results.bundlers.push({
			label: 'lightningcss',
			success: (!serverError && !pageError && !requestHandlerError) && (
				result[0] === 'rgb(0, 128, 0)' ||
				(
					imageWasRequested && result[1].includes('/green.png')
				)
			),
			result: result,
		});
	}

	{
		resetState();
		await page.goto(`http://localhost:8080/esbuild.html`);
		const result = await page.evaluate(async () => {
			const box = document.getElementById('box');
			const style = window.getComputedStyle(box);
			return [style.backgroundColor, style.backgroundImage];
		});

		results.bundlers.push({
			label: 'esbuild',
			success: (!serverError && !pageError && !requestHandlerError) && (
				result[0] === 'rgb(0, 128, 0)' ||
				(
					imageWasRequested && result[1].includes('/green.png')
				)
			),
			result: result,
		});
	}

	await page.close();

	await server.closeAllConnections();
	await server.close();

	results.error = errors.length > 0 ? errors : null;
	results.success = !results.error && results.bundlers.every((x => x.success === true));
	return results;
}
