/**
 * Kitty Kaki Survivors — Main Menu hero splash (Iter 37).
 *
 * Replaces the static SVG silhouette on the title screen with the REAL hero
 * model — the same GLB the in-game hero and the Heroes-tab carousel render
 * (cloneCached('hero'), tinted/scaled per selected avatar) — slow-rotating on
 * an alpha canvas. Decorative only: pointer-events:none, no interaction.
 *
 * Self-contained, mirrors charCarousel.js's renderer + disposal discipline:
 *   - clone materials BEFORE tinting; dispose ONLY those clones on teardown.
 *     The cached GLTF (geometry + original materials) is shared with the
 *     in-game hero render — never mutate or dispose it.
 *   - RO-deferred sizing: the host (.kkv2-hero) is built detached and sized
 *     by its parent AFTER this returns, so clientWidth is 0 at init. The first
 *     ResizeObserver fire (when real dimensions land) sets renderer size and
 *     starts the RAF.
 *
 * Returns a { destroy } handle, or null when the hero GLTF isn't cached yet —
 * in which case the caller keeps the SVG silhouette as a graceful fallback.
 */
import * as THREE from 'three';
import { cloneCached, lazyLoadGLTF, BASE } from './assets.js';
import { createPreviewRendererAdapter } from './rendering/previewRendererAdapter.js';

// Match charCarousel's preview scale (NOT HERO.targetHeight=3.6, which is the
// in-world scale relative to enemies — far too large at this camera distance).
const TARGET_HEIGHT = 1.4;
// The menu animation is deliberately slow; 30 fps is visually identical while
// halving work in this second WebGL context (and capping 120/144 Hz displays).
const MENU_FRAME_MS = 1000 / 30;
// Placeholder dance rhythm until menu music lands. A ~110 BPM two-step bop:
// hop + alternating lean + happy look-around turn + squash-stretch juice.
// Amplitudes are kept low so the framed bust stays in frame.
const DANCE_BPM = 110;

/**
 * @param {HTMLElement} host - mount target (.kkv2-hero)
 * @param {Object} opts
 * @param {string} [opts.avatarId]
 * @param {number} [opts.tint]      - avatar tint (multiplied into material color)
 * @param {number} [opts.scaleMul]  - avatar scale multiplier
 * @param {string} [opts.glb]       - avatar's dedicated GLB filename, if any
 * @returns {{destroy:()=>void}|null}
 */
export function createHeroSplash(host, opts = {}) {
  if (!host) return null;
  const avatarId = opts.avatarId || 'kitty';
  const ownKey = opts.glb ? `hero_${avatarId}` : null;
  // Pick the best model available right now: the avatar's own GLB if it's
  // already cached, else the shared hero donor (always preloaded). When only
  // the donor is ready we still kick a lazy-load of the avatar GLB below and
  // swap it in when it lands — most avatar GLBs (sote.glb etc.) aren't
  // preloaded unless that avatar is the selected one.
  let usedKey = null;
  let initialMesh = null;
  if (ownKey) { initialMesh = cloneCached(ownKey); if (initialMesh) usedKey = ownKey; }
  if (!initialMesh) { initialMesh = cloneCached('hero'); if (initialMesh) usedKey = 'hero'; }
  if (!initialMesh) return null;   // nothing cached → caller keeps the SVG fallback

  const previewRenderer = createPreviewRendererAdapter({
    THREE,
    mount: host,
    rendererOptions: { alpha: true, antialias: true },
    configureRenderer: (renderer) => {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    },
    canvasClassName: 'kkv2-hero-canvas',
    canvasStyle:
      'position:absolute; inset:0; width:100%; height:100%; display:block;' +
      'pointer-events:none; filter: drop-shadow(0 30px 50px rgba(0,0,0,.7));',
    loadingText: 'Preparing hero preview…',
    errorText: 'Hero preview unavailable.',
  });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 0.78, 0.1, 50);
  camera.position.set(0, 0.9, 4.8);
  camera.lookAt(0, 0.72, 0);

  // Lights — match the carousel for readability parity.
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const keyL = new THREE.DirectionalLight(0xfff3cc, 1.1);
  keyL.position.set(2.5, 4, 3);
  scene.add(keyL);
  const rimL = new THREE.DirectionalLight(0x7fffe4, 0.5);
  rimL.position.set(-3, 2, -2);
  scene.add(rimL);

  const group = new THREE.Group();
  scene.add(group);

  // ── Model mount (auto-fit + center + tint) ──────────────────────────
  // Factored so the lazy-load swap can re-mount the real avatar GLB over the
  // donor placeholder. Disposes only OUR cloned materials between mounts;
  // geometry + original materials belong to the shared cache — never touched.
  const tint = new THREE.Color(opts.tint != null ? opts.tint : 0xffffff);
  let ownedMats = [];
  let modelMesh = null;

  function mountModel(raw) {
    if (modelMesh) group.remove(modelMesh);
    for (const m of ownedMats) { try { m.dispose(); } catch (_) {} }
    ownedMats = [];

    const b1 = new THREE.Box3().setFromObject(raw);
    const s1 = b1.getSize(new THREE.Vector3());
    const fit = s1.y > 1e-6 ? TARGET_HEIGHT / s1.y : 1;
    raw.scale.setScalar(fit * (opts.scaleMul || 1));

    // Re-measure post-scale to center on X/Z and seat the feet at y=0.
    const b2 = new THREE.Box3().setFromObject(raw);
    const c2 = b2.getCenter(new THREE.Vector3());
    raw.position.x -= c2.x;
    raw.position.z -= c2.z;
    raw.position.y -= b2.min.y;

    raw.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const isArr = Array.isArray(o.material);
      const src = isArr ? o.material : [o.material];
      const cloned = src.map((m) => {
        const cm = m.clone();          // clone BEFORE mutating — cache is shared
        if (cm.color) cm.color.multiply(tint);
        ownedMats.push(cm);
        return cm;
      });
      o.material = isArr ? cloned : cloned[0];
      o.castShadow = false;
      o.receiveShadow = false;
    });
    group.add(raw);
    modelMesh = raw;
  }

  mountModel(initialMesh);

  // If the avatar has its own GLB but we only had the donor ready, fetch the
  // real model and swap it in when it lands.
  let _destroyed = false;
  if (ownKey && usedKey !== ownKey && opts.glb) {
    lazyLoadGLTF(ownKey, BASE + opts.glb).then((ok) => {
      if (_destroyed || !ok) return;
      const real = cloneCached(ownKey);
      if (real) mountModel(real);
    }).catch(() => {});
  }

  // ── RO-deferred sizing + render loop ────────────────────────────────
  let _raf = 0;
  let _started = false;
  let lastT = 0;
  let nextRenderAt = 0;
  let _t = 0;     // dance clock (seconds)
  let w = 0;
  let h = 0;

  function resize() {
    const rect = host.getBoundingClientRect();
    const nw = Math.max(1, Math.floor(rect.width));
    const nh = Math.max(1, Math.floor(rect.height));
    if (nw === w && nh === h) return;
    w = nw; h = nh;
    previewRenderer.resize(w, h, false); // false: CSS (inset:0/100%) drives display size
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!_started) {
      _started = true;
      lastT = performance.now();
      _raf = requestAnimationFrame(tick);
    }
  }

  function tick(now) {
    if (_destroyed || previewRenderer.state === 'failed') {
      _raf = 0;
      return;
    }
    _raf = requestAnimationFrame(tick);
    if (now < nextRenderAt) return;
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    nextRenderAt = now + MENU_FRAME_MS;
    _t += dt;

    // ── Dance ──────────────────────────────────────────────────────────
    const ph = 2 * Math.PI * (DANCE_BPM / 60) * _t;   // beat phase (rad)
    const bounce = Math.abs(Math.sin(ph * 0.5));      // one hop per beat (0..1)
    group.position.y = 0.03 * bounce;                  // small hop (head stays framed)
    group.position.x = 0.15 * Math.sin(_t * 0.8);      // sway side to side
    group.rotation.z = 0.12 * Math.sin(ph * 0.25);     // alternating lean (two-step)
    // Gentle bounded look-around (±~20°). NO continuous drift term — that
    // accumulated past 180° and turned the model's back to the camera.
    group.rotation.y = 0.35 * Math.sin(_t * 0.8);
    const sq = 1 + 0.035 * bounce;                     // squash-stretch on the hop
    group.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));

    previewRenderer.render(scene, camera);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();   // attempt immediate size in case host is already laid out

  return {
    whenRendererReady: () => previewRenderer.ready,
    getRendererDiagnostics: () => previewRenderer.getDiagnostics(),
    destroy() {
      if (_destroyed) return;
      _destroyed = true;
      if (_raf) cancelAnimationFrame(_raf);
      _raf = 0;
      try { ro.disconnect(); } catch (_) {}
      for (const m of ownedMats) { try { m.dispose(); } catch (_) {} }
      previewRenderer.destroy();
    },
  };
}
