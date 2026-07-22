#!/usr/bin/env node
/**
 * Deterministic headless runner for the supersampled Forest enemy atlas v2.
 *
 *   node tools/enemy-sprite-bake/run.mjs
 *   node tools/enemy-sprite-bake/run.mjs ant,mantis   # preview subset
 */
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateForestManifest } from './validate-silhouettes.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const BAKE_HTML = path.join(HERE, 'bake.html');
const only = (process.argv[2] || '').trim();
const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
});

function resolveBrowserTools() {
  const candidates = [
    '/home/nemoclaw/.nemoclaw/playwright/node_modules/playwright-core',
    '/home/nemoclaw/node_modules/playwright',
  ];
  const modulePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!modulePath) throw new Error(`Playwright not found at ${candidates.join(' or ')}`);
  const chromiumCandidates = [
    '/home/nemoclaw/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',
    '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  ];
  const executablePath = chromiumCandidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) throw new Error('A compatible Playwright Chromium executable was not found');
  return { chromium: require(modulePath).chromium, executablePath };
}

const server = createServer((request, response) => {
  try {
    const parsed = new URL(request.url || '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(parsed.pathname);
    const filePath = (pathname === '/' || pathname === '/bake.html')
      ? BAKE_HTML
      : path.resolve(ROOT, pathname.replace(/^\/+/, ''));
    const withinRoot = filePath === ROOT || filePath.startsWith(`${ROOT}${path.sep}`) || filePath === BAKE_HTML;
    if (!withinRoot || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
    });
    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error.message);
  }
});

let browser = null;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium, executablePath } = resolveBrowserTools();
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('console', (message) => console.log(`[baker:${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => console.error(`[baker:pageerror] ${error.message}`));
  const query = only ? `?only=${encodeURIComponent(only)}` : '';
  await page.goto(`${origin}/bake.html${query}`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(
    () => window.__r && window.__r.status !== 'baking',
    null,
    { timeout: 600_000, polling: 250 },
  );
  const result = await page.evaluate(() => window.__r);
  if (result.status !== 'ok') throw new Error(result.error || `Baker ended in ${result.status}`);
  const imageName = result.json.image;
  const manifestName = imageName.replace(/\.png$/i, '.json');
  const imagePath = path.join(ROOT, 'assets', 'sprites', imageName);
  const manifestPath = path.join(ROOT, 'assets', 'sprites', manifestName);
  const png = Buffer.from(result.png.replace(/^data:image\/png;base64,/, ''), 'base64');
  fs.writeFileSync(imagePath, png);
  fs.writeFileSync(manifestPath, `${JSON.stringify(result.json, null, 2)}\n`);

  let validation = null;
  if (!only) {
    validation = validateForestManifest(manifestPath);
    const reportPath = path.join(ROOT, 'docs', 'enemy-animation', 'SILHOUETTE_VALIDATION.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(validation, null, 2)}\n`);
  }
  console.log(`BAKED ${result.names.join(',')}`);
  console.log(`atlas=${path.relative(ROOT, imagePath)} ${result.width}x${result.height} frames=${result.frames} bytes=${png.length}`);
  console.log(`manifest=${path.relative(ROOT, manifestPath)}`);
  if (validation) console.log(`silhouette-validation=PASS species=${validation.species.length}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
