// Headless baker: renders 3D enemy GLBs from the in-game camera pitch (~47 deg)
// into a single sprite atlas (assets/sprites/enemies_v1.{png,json}). The trash
// horde renders these as billboards (one InstancedMesh / draw call per atlas)
// instead of N SkinnedMeshes — the fix for the render-bound 280-enemy frame.
//
// Run:   node tools/enemy-sprite-bake/run.mjs            # bake all 23
//        node tools/enemy-sprite-bake/run.mjs zombie     # bake one (?only=)
//        node tools/enemy-sprite-bake/run.mjs zombie,orc # bake a subset
//
// Requires playwright-core + a chromium with swiftshader (paths below match
// this workstation's cache). Output is deterministic enough for review; the
// procedural bob frames use no RNG.
import pkg from '/home/nemoclaw/.nemoclaw/playwright/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const EXE = '/home/nemoclaw/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
import { createServer } from 'http';
import { readFile, writeFile } from 'fs/promises';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));     // tools/enemy-sprite-bake
const ROOT = join(HERE, '..', '..');                       // repo root
const BAKE_HTML = join(HERE, 'bake.html');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.glb':'model/gltf-binary', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.bin':'application/octet-stream' };
const only = process.argv[2] || '';

const srv = createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = (url === '/' || url === '/bake.html') ? BAKE_HTML : join(ROOT, url);
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => srv.listen(9479, r));

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
page.on('console', m => console.log('PAGE:', m.type(), m.text()));
page.on('pageerror', e => console.log('PAGEERR:', e.message));
const q = only ? `?only=${only}` : '';
await page.goto('http://localhost:9479/bake.html' + q);
await page.waitForFunction(() => window.__r && window.__r.status !== 'baking', { timeout: 240000 }).catch(()=>{});
const r = await page.evaluate(() => window.__r);
if (r.status === 'ok') {
  const b64 = r.png.replace(/^data:image\/png;base64,/, '');
  await writeFile(join(ROOT, 'assets/sprites/enemies_v1.png'), Buffer.from(b64, 'base64'));
  await writeFile(join(ROOT, 'assets/sprites/enemies_v1.json'), JSON.stringify(r.json, null, 2));
  console.log('BAKED', r.names.join(','), 'cols=' + r.cols);
} else {
  console.log('BAKE FAIL:', r.status, r.error || '');
  process.exitCode = 1;
}
await browser.close();
srv.close();
