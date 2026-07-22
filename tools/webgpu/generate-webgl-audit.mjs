#!/usr/bin/env node
/** Generate the exhaustive WebGL dependency appendix used by Gate 1. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = path.join(ROOT, 'docs/webgpu/WEBGL_DEPENDENCY_AUDIT.md');
const SOURCE_COMMIT = '059ff0b6e05d09471de1a0fe02db5851d5f0a463';
const OVERLAY_START = '<!-- CURRENT_BRANCH_OVERLAY_START -->';
const OVERLAY_END = '<!-- CURRENT_BRANCH_OVERLAY_END -->';
const SKIP_DIRS = new Set(['.git', 'assets', 'node_modules', 'vendor', 'BASELINE_SCREENSHOTS']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.md', '.json']);

const RULES = [
  ['WebGLRenderer', /\bWebGLRenderer\b/g, 'WebGL renderer construction or documentation', true, 'WebGPURenderer behind the renderer service'],
  ['WebGLRenderTarget', /\bWebGLRenderTarget\b/g, 'WebGL render-target API', true, 'RenderTarget or RenderPipeline-managed texture'],
  ['WebGLMultipleRenderTargets', /\bWebGLMultipleRenderTargets\b/g, 'Removed WebGL MRT API', true, 'RenderTarget count or TSL mrt()'],
  ['WebGLRenderLists', /\bWebGLRenderLists\b/g, 'WebGL renderer internal', true, 'No direct access; renderer diagnostics/service'],
  ['WebGLProperties', /\bWebGLProperties\b/g, 'WebGL renderer internal', true, 'No direct access; renderer diagnostics/service'],
  ['WebGLProgram', /\bWebGLProgram\b/g, 'WebGL program internal', true, 'TSL node graph and pipeline diagnostics'],
  ['getContext', /\bgetContext\s*\(/g, 'Canvas or raw graphics-context access', null, 'Canvas 2D stays; graphics readback moves to captureFrame()'],
  ['webgl2', /\bwebgl2\b/gi, 'WebGL 2 capability, backend, flag, or documentation reference', false, 'Renderer capability/backend service'],
  ['webgl', /\bwebgl\b/gi, 'WebGL capability, backend, flag, or documentation reference', false, 'Backend-neutral renderer service or isolated legacy QA'],
  ['ShaderMaterial', /\bShaderMaterial\b/g, 'GLSL-authored material or related test/documentation', true, 'Typed TSL NodeMaterial'],
  ['RawShaderMaterial', /\bRawShaderMaterial\b/g, 'Raw GLSL material', true, 'Typed TSL NodeMaterial'],
  ['onBeforeCompile', /\bonBeforeCompile\b/g, 'WebGL shader-source injection', true, 'Reusable TSL material/node function'],
  ['glslVersion', /\bglslVersion\b/g, 'Explicit GLSL version dependency', true, 'TSL-generated backend shader'],
  ['vertexShader', /\bvertexShader\b/g, 'Inline or mutated GLSL vertex stage', true, 'TSL positionNode or authored animation'],
  ['fragmentShader', /\bfragmentShader\b/g, 'Inline or mutated GLSL fragment stage', true, 'TSL color/emissive/opacity/output nodes'],
  ['EffectComposer', /\bEffectComposer\b/g, 'Legacy WebGL post-processing composer', true, 'RenderPipeline'],
  ['ShaderPass', /\bShaderPass\b/g, 'Legacy GLSL post-processing pass', true, 'TSL output-node stage'],
  ['RenderPass', /\bRenderPass\b/g, 'Legacy scene render pass', true, 'TSL pass(scene, camera)'],
  ['OutputPass', /\bOutputPass\b/g, 'Legacy output transform pass', true, 'RenderPipeline output color transform'],
  ['UnrealBloomPass', /\bUnrealBloomPass\b/g, 'Legacy WebGL bloom pass', true, 'TSL BloomNode'],
  ['readRenderTargetPixels', /\breadRenderTargetPixels\b/g, 'Synchronous rendered-pixel readback', true, 'Renderer-service asynchronous capture/readback'],
  ['renderer.properties', /\brenderer\.properties\b/g, 'WebGL renderer internal properties', true, 'No direct access'],
  ['renderer.state', /\brenderer\.state\b/g, 'WebGL renderer internal state', true, 'No direct access'],
  ['renderer.context', /\brenderer\.context\b/g, 'WebGL renderer internal context', true, 'No direct access'],
  ['renderer.info', /\brenderer\.info\b/g, 'Renderer counters', false, 'Backend-neutral getDiagnostics()'],
  ['renderer.compile', /\brenderer\.compile(?:Async)?\b/g, 'Pipeline/shader warmup', false, 'Renderer-service compileAsync() warmup'],
  ['preserveDrawingBuffer', /\bpreserveDrawingBuffer\b/g, 'Persistent canvas back buffer', false, 'Explicit captureFrame() path'],
  ['toDataURL', /\btoDataURL\b/g, 'Synchronous canvas encoding', false, 'Canvas toBlob() or captureFrame()'],
  ['CustomBlending', /\bCustomBlending\b/g, 'Custom blend equations', false, 'Validate supported NodeMaterial blending'],
  ['customDepthMaterial', /\bcustomDepthMaterial\b/g, 'Custom depth shader path', true, 'NodeMaterial-compatible depth/shadow path'],
  ['customDistanceMaterial', /\bcustomDistanceMaterial\b/g, 'Custom distance shader path', true, 'NodeMaterial-compatible distance/shadow path'],
  ['selective bloom layer', /(?:\.layers\.(?:enable|disable|set|test|isEnabled)\s*\(|\bBLOOM_LAYER\b)/g, 'Selective-bloom membership or layer manipulation', false, 'Semantic setSelectiveBloom() backed by stable MRT'],
];

function filesAtSourceCommit() {
  const tracked = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', SOURCE_COMMIT],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return tracked.split(/\r?\n/).filter((file) => {
    if (!file || !EXTENSIONS.has(path.extname(file))) return false;
    return !file.split('/').some((part) => SKIP_DIRS.has(part));
  }).sort();
}

function readAtSourceCommit(file) {
  return execFileSync(
    'git',
    ['show', `${SOURCE_COMMIT}:${file}`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

function ownerFor(lines, index) {
  for (let i = index; i >= Math.max(0, index - 180); i--) {
    const line = lines[i];
    let match = line.match(/(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/);
    if (match) return match[1];
    match = line.match(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/);
    if (match) return match[1];
    match = line.match(/^\s*(?:async\s+)?([\w$]+)\s*\([^)]*\)\s*\{/);
    if (match && !['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) return match[1];
  }
  return 'module scope';
}

function testScene(file, rule) {
  if (/postfx|bloom/i.test(file + rule)) return '?qa=postfx';
  if (/racing|monster|trials|crash/i.test(file)) return 'Rally/Draw Track/Monster Smash/Trials/Catastrophe';
  if (/bullethell/i.test(file)) return 'Bullet Hell dense-projectile scene';
  if (/town|interior|casino|charCarousel|menuHero/i.test(file)) return 'Menu, hero selection, Town/interiors';
  if (/cave|catacomb|dungeon/i.test(file)) return 'Cave and Catacomb';
  if (/stage|forest|cinder|twilight|void|env/i.test(file)) return '?qa=all-materials plus affected stage';
  if (/weapon|enemy|hero|pickup|fx|sprite/i.test(file)) return '?qa=forest-horde and max-weapon FX';
  if (file.startsWith('tools/')) return 'Tool-specific smoke';
  return 'Boot plus mode lifecycle matrix';
}

function risks(rule, file) {
  const visualCritical = /Shader|onBeforeCompile|Bloom|Composer|Pass|layer/i.test(rule);
  const perfCritical = /Renderer|RenderTarget|Composer|Bloom|readRender|preserve/i.test(rule);
  const toolOnly = file.startsWith('tools/');
  return {
    visual: toolOnly ? 'None (tool)' : (visualCritical ? 'High' : 'Medium'),
    perf: toolOnly ? 'None (tool)' : (perfCritical ? 'High' : 'Low'),
  };
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Keep the hand-maintained current-branch resolution snapshot separate from
 * the generated frozen-source appendix. This lets Gate 1 be reproduced
 * without erasing later migration evidence.
 */
function readCurrentBranchOverlay() {
  if (!fs.existsSync(OUTPUT)) return [];

  const existing = fs.readFileSync(OUTPUT, 'utf8');
  const markedStart = existing.indexOf(OVERLAY_START);
  if (markedStart >= 0) {
    const markedEnd = existing.indexOf(OVERLAY_END, markedStart);
    if (markedEnd < 0) {
      throw new Error(`Found ${OVERLAY_START} without ${OVERLAY_END} in ${path.relative(ROOT, OUTPUT)}.`);
    }
    const overlay = existing
      .slice(markedStart + OVERLAY_START.length, markedEnd)
      .trim();
    return [OVERLAY_START, '', overlay, '', OVERLAY_END];
  }

  // Backward-compatible adoption for reports generated before the explicit
  // markers were introduced.
  const legacyStart = existing.indexOf('## Current branch resolution snapshot');
  const legacyEnd = existing.indexOf('## Gate 1 conclusions', legacyStart);
  if (legacyStart >= 0 && legacyEnd > legacyStart) {
    const overlay = existing.slice(legacyStart, legacyEnd).trim();
    return [OVERLAY_START, '', overlay, '', OVERLAY_END];
  }

  return [];
}

const files = filesAtSourceCommit();
const rows = [];
const counts = new Map();
for (const file of files) {
  const lines = readAtSourceCommit(file).split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const source = lines[lineIndex];
    for (const [name, regex, purpose, webglOnly, replacement] of RULES) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(source))) {
        // The generic webgl rule must not double-count the more specific webgl2 token.
        if (name === 'webgl' && /^webgl2$/i.test(match[0])) continue;
        const resolvedOnly = name === 'getContext'
          ? !/getContext\s*\(\s*['\"]2d['\"]/.test(source)
          : webglOnly;
        const risk = risks(name, file);
        rows.push({
          dependency: name,
          file,
          line: lineIndex + 1,
          owner: ownerFor(lines, lineIndex),
          purpose,
          webglOnly: resolvedOnly == null ? 'Review' : (resolvedOnly ? 'Yes' : 'No'),
          replacement,
          visual: risk.visual,
          perf: risk.perf,
          test: testScene(file, name),
          status: file.startsWith('tools/') ? 'Isolate or migrate with QA' : 'Open',
        });
        counts.set(name, (counts.get(name) || 0) + 1);
        if (match[0].length === 0) regex.lastIndex++;
      }
    }
  }
}

const summary = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const currentBranchOverlay = readCurrentBranchOverlay();
const lines = [
  '# WebGL Dependency Audit',
  '',
  `Baseline source commit: \`${SOURCE_COMMIT}\``,
  '',
  'Audit scope: the complete text/code repository at the recorded source commit, excluding binary assets, dependencies, Git metadata, the future vendor tree, generated baseline screenshots, and this generated report itself. Tool-only findings remain listed so capture and bake utilities are not silently forgotten.',
  '',
  'The frozen-source appendix is generated by `node tools/webgpu/generate-webgl-audit.mjs`. Each occurrence is retained in the exhaustive table, including comments and tests, because those references often encode migration contracts that must change with production code. The marked current-branch overlay is preserved verbatim when the appendix is regenerated.',
  '',
  ...currentBranchOverlay,
  ...(currentBranchOverlay.length > 0 ? [''] : []),
  '## Gate 1 conclusions',
  '',
  '- Three production renderers exist: the main game, character carousel, and menu hero splash.',
  '- Nine production `ShaderMaterial` constructors, three `onBeforeCompile` assignments, and two GLSL `ShaderPass` definitions block WebGPU.',
  '- Selective bloom is coupled to executable layer operations across roughly seventy modules; it needs one semantic membership API before the stable MRT implementation replaces it.',
  '- The main game owns a manual RAF loop, renderer/composer globals, direct counters/capabilities, and WebGL context-loss events. There is no production renderer/composer disposal path.',
  '- Production has no rendered-frame readback. `shareCard.js` is Canvas2D-only and remains backend-neutral. Two browser smokes use raw `gl.readPixels`; the sprite baker intentionally uses an isolated WebGL context with `preserveDrawingBuffer`.',
  '- No WebGPU, TSL, `RawShaderMaterial`, explicit WebGL render-target class, renderer-internal properties/state/program access, custom depth material, custom distance material, or custom blend equation was found.',
  '',
  '## Blocking surfaces',
  '',
  '| ID | File / owner | Purpose | WebGPU replacement | Visual risk | Performance risk | Test scene | Status |',
  '|---|---|---|---|---|---|---|---|',
  '| R01 | `src/main.js` module bootstrap | Primary renderer, output, shadows and DPR | Async renderer service with `WebGPURenderer` | Critical | Critical | Every mode | Open |',
  '| R02 | `src/charCarousel.js:createCharCarousel` | Independent preview renderer and RAF | Service-managed preview renderer | High | Medium | Hero selection | Open |',
  '| R03 | `src/menuHeroSplash.js:createHeroSplash` | Independent splash renderer and RAF | Service-managed preview renderer | High | Medium | Main menu | Open |',
  '| R04 | `src/state.js` renderer/composer fields | WebGL-typed global ownership | Renderer service and backend-neutral diagnostics | Medium | High | Recreation and lifecycle | In progress: service published; legacy fields retained for post-FX cutover |',
  '| R05 | `src/main.js:renderFrame` | Dual scene render, layer mask, bloom composite | One stable MRT RenderPipeline | Critical | Critical | `?qa=postfx` | Open |',
  '| R06 | `src/postfx.js:createComposer` | EffectComposer chain and render-target texture read | Stable `RenderPipeline` and TSL nodes | Critical | Critical | `?qa=postfx` | Open |',
  '| R07 | `src/main.js:frame` | Manually owned RAF before async renderer init | One lifecycle-owned animation loop | Medium | Critical | Duplicate-loop/recreation tests | Migrated in legacy r185: one `setAnimationLoop` owner |',
  '| R08 | `src/main.js` context handlers | WebGL context loss and delayed page reload | Device-loss pause/save/recreate/switch flow | Medium | High | Device recovery | Open |',
  '| R09 | perf and racing diagnostics | Direct `renderer.info` reads | `getDiagnostics()` adapter | Low | Medium | F3 and perf suites | Migrated to normalized service diagnostics |',
  '| R10 | env/racing capability reads | Direct anisotropy/capability access | `getCapabilities()` adapter | Low | Low | All stages and racing | Migrated to service capabilities |',
  '| R11 | input/UI/racing camera consumers | Direct `renderer.domElement` access | Inject canvas/viewport service | Medium | Low | Aim, touch, resize, cameras | Migrated to service canvas accessor |',
  '| R12 | `tools/enemy-sprite-bake/bake.html` | Intentional offline WebGL bake/readback | Keep isolated or migrate separately | None | None | Sprite bake tool | Tool-only |',
  '',
  '## Custom shader conversion map',
  '',
  '| File / owner | Current purpose | Replacement | Visual risk | Performance risk | Test scene | Status |',
  '|---|---|---|---|---|---|---|',
  '| `src/assets.js:_injectVertAnim` | Crawl/flap/hover/inch vertex deformation | TSL `positionNode`, morph, or authored animation | High | Medium | Horde/material gallery | Open |',
  '| `src/assets.js:_injectRim` | View-space GLB rim light | Reusable standard-node emissive/rim function | Critical | Medium | Heroes, enemies, NPCs | Open |',
  '| `src/racing/trialsMode.js:_buildParticlePool` | Per-instance particle alpha injection | Instance-attribute opacity node | Medium | Low | Trials | Open |',
  '| `src/env.js:_buildAtmosCluster` | Per-point atmosphere size/alpha | `PointsNodeMaterial` | High | High | Every stage | Open |',
  '| `src/forestPortals.js:_makeGateVeilMaterial` | Animated portal veil | Basic node color/opacity | High | Low | Forest portal | Open |',
  '| `src/forestSkyDome.js:loadForestSkyDome` | Day/night texture crossfade | Texture-node mix | High | Low | Forest time phases | Open |',
  '| `src/stages/cave/caveSkyDome.js:buildCaveSkyDome` | Cave vertical gradient | UV-driven basic node | Medium | Low | Cave | Open |',
  '| `src/stageLandscapes.js:_waterMaterial` | Animated instanced water | World-position/time TSL nodes | High | Medium | Twilight/Cave | Open |',
  '| `src/stageLandscapes.js:_terrainRibbonMaterial` | Lava/abyss ribbons and banks | Basic/standard node material | Critical | Medium | Cinder/Void | Open |',
  '| `src/stageHazards.js:initStageHazards` | Twilight fog and discarded Void chasm | Node color/opacity/discard | Critical | Low | Twilight/Void | Open |',
  '| `src/sprites/spritePool.js:ensurePool` | Atlas frame, billboard, flash, alpha cutoff | Instance-driven node material | Critical | Critical | Sprite/horde gallery | Open |',
  '| `src/postfx.js:PostFXShader` | Chromatic, height fog, grade, accessibility, vignette | TSL post nodes | Critical | High | `?qa=postfx` | Open |',
  '| `src/postfx.js:BloomCompositeShader` | Add selective bloom texture | MRT output plus BloomNode | Critical | High | `?qa=postfx` | Open |',
  '',
  '## Production coupling detail',
  '',
  '- Executable selective-bloom layer operations: 152 across 70 production files. `fx/novaBurst.js` also hardcodes `layers.isEnabled(1)`; `bossTelegraphs.js` and `fx.js` inherit membership through `applyFloorTier`.',
  '- Built-in additive blending: 135 occurrences across 76 production files. Normal blending is explicit at 20 sites across 18 files.',
  '- Depth/transparency review surface: 229 `depthWrite` references across 100 files, 81 `renderOrder` references, 28 `alphaTest` references, and 75 `polygonOffset` references.',
  '- Built-in blend/depth settings are not inherently WebGL-only, but dense projectiles, sprites, decals, portals, racing VFX, and hero bloom occlusion require backend-paired captures.',
  '- `stageLandscapes.js` advances shader time through per-object `onBeforeRender`; the TSL port will use one frame uniform update.',
  '- Two QA tools (`smoke-cave-v2.mjs` and `smoke-town-visual.mjs`) perform raw `gl.readPixels`; the backend-neutral replacement is screenshot/capture-service validation.',
  '',
  '## Search-term counts',
  '',
  '| Dependency | Matches |',
  '|---|---:|',
  ...summary.map(([name, count]) => `| ${escapeCell(name)} | ${count} |`),
  '',
  `Total catalogued occurrences: **${rows.length}**.`,
  '',
  '## Exhaustive occurrence catalog',
  '',
  '| Dependency | File | Function / scope | Purpose | WebGL-only | WebGPU replacement | Visual risk | Performance risk | Test scene | Migration status |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((row) => `| ${escapeCell(row.dependency)} | \`${row.file}:${row.line}\` | ${escapeCell(row.owner)} | ${escapeCell(row.purpose)} | ${row.webglOnly} | ${escapeCell(row.replacement)} | ${row.visual} | ${row.perf} | ${escapeCell(row.test)} | ${row.status} |`),
  '',
];

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, lines.join('\n'));
console.log(`Wrote ${path.relative(ROOT, OUTPUT)} with ${rows.length} occurrences across ${files.length} files.`);
