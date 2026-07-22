#!/usr/bin/env node
/**
 * Focused visual contract for the Forest combat-readability replacement pass.
 *
 * Proves the tar hazard, burger orbitals, XP, player/hostile projectiles and
 * Nova use decoded authored assets; verifies depth/bloom roles; and confirms
 * reward markers never regress to gold ground rings. Writes human-review shots.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8816);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function mime(p) {
  if (/\.m?js$/.test(p)) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.glb')) return 'model/gltf-binary';
  if (p.endsWith('.ogg')) return 'audio/ogg';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  if (p.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, '.' + rel);
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const imageInfo = (mesh) => {
  const image = mesh?.material?.map?.image;
  return {
    src: image?.currentSrc || image?.src || '',
    width: image?.naturalWidth || image?.width || 0,
    height: image?.naturalHeight || image?.height || 0,
  };
};

async function main() {
  if (!fs.existsSync(PLAY_PATH) || !fs.existsSync(EXEC)) {
    throw new Error('Playwright/Chromium workspace cache missing');
  }
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const failures = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${ORIGIN}/index.html?smoke=forest-combat-visuals`, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: 90_000 });
    await page.evaluate(async () => {
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      const meta = await import('./src/meta.js');
      meta.setOption('selectedStage', 'forest');
      meta.setOption('optMusic', false);
      const s = window.kkState;
      s.replaySeed = { seed: 'forest-combat-visuals-v1', stage: 'forest', character: 'kitty', mode: 'normal' };
      s.weapons.length = 0;
      await window.kkStartRun();
    });
    await page.waitForFunction(() => window.kkState?.mode === 'run' && window.kkState?.run?.stage?.id === 'forest', null, { timeout: 90_000 });
    await page.waitForTimeout(2400);

    await page.evaluate(async () => {
      const THREE = await import('three');
      const s = window.kkState;
      s.hero.hpMax = s.hero.hp = 1e9;
      s.run.lockdownActive = true;
      const enemies = await import('./src/enemies.js');
      for (const e of s.enemies.active) {
        e.alive = false;
        try { enemies.releaseEnemyVisual(e); } catch (_) {}
      }
      s.enemies.active.length = 0;
      if (s.enemies.spatial?.clear) s.enemies.spatial.clear();
      // Remove shots fired during the brief boot window so the screenshot is
      // a clean comparison of the replacement assets, not a frozen projectile.
      const autoAim = await import('./src/weapons/autoAim.js');
      for (const p of s.projectiles.active) autoAim.releaseProjectileVisuals(p);
      s.projectiles.active.length = 0;

      const tar = (() => {
        let hit = null;
        s.scene.traverse((o) => { if (!hit && o.isInstancedMesh && o.userData?.envHazardKind === 'tar_pit') hit = o; });
        return hit;
      })();
      if (!tar) throw new Error('tar-pit InstancedMesh not found');
      tar.updateMatrixWorld(true);
      const local = new THREE.Matrix4();
      const world = new THREE.Matrix4();
      const tarPos = new THREE.Vector3();
      tar.getMatrixAt(0, local);
      world.copy(tar.matrixWorld).multiply(local);
      tarPos.setFromMatrixPosition(world);

      const hx = tarPos.x + 5.2;
      const hz = tarPos.z;
      s.hero.pos.set(hx, 0, hz);
      s.hero.vel.set(0, 0, 0);
      if (s.hero.mesh) s.hero.mesh.position.set(hx, s.hero.mesh.position.y, hz);
      s.hero.statMul.magnet = 1;

      const xp = await import('./src/xp.js');
      const weapons = await import('./src/weapons/index.js');
      if (!s.weapons.some((w) => w.id === 'orbitals')) weapons.acquireWeapon('orbitals');
      const values = [1, 1, 5, 1, 20, 1, 5];
      for (let i = 0; i < values.length; i++) {
        const a = (i / values.length) * Math.PI * 2;
        xp.dropGem(new THREE.Vector3(hx + Math.cos(a) * 4.1, 0, hz + Math.sin(a) * 4.1), values[i]);
      }

      // One pickup from each Forest family. These used to carry the plain
      // yellow rune rings reported in gameplay screenshots.
      const forestPickups = await import('./src/forestPickups.js');
      forestPickups.disposeForestPickups(s.scene);
      forestPickups.loadForestPickups(s.scene, s);
      forestPickups.dropForestPickup({ x: hx - 3.2, z: hz - 0.8 }, 0.001, 1.0);
      forestPickups.dropForestPickup({ x: hx + 0.2, z: hz - 3.2 }, 0.010, 1.0);
      forestPickups.dropForestPickup({ x: hx + 3.2, z: hz + 1.0 }, 0.050, 0.2);

      // Freeze a small authored paw-comet fan in frame. Both normal and ice
      // variants share the same pooled Grok sprite with restrained tinting.
      const stillShot = { speed: 0, ttl: 999, pierce: 99 };
      autoAim.spawnAutoAimProjectile({ x: hx - 1.6, z: hz - 2.2 }, { x: 1, z: 0 }, stillShot, 1);
      autoAim.spawnAutoAimProjectile({ x: hx - 1.6, z: hz + 2.2 }, { x: 0.7, z: 0.7 }, stillShot, 1);
      autoAim.spawnAutoAimProjectile(
        { x: hx + 0.2, z: hz - 2.2 },
        { x: -0.7, z: 0.7 },
        stillShot,
        1,
        1,
        0,
        'glasswind',
        { ice: true },
      );
      autoAim.flushProjectileVisuals();

      // Spawn the exact Helltide interactable that used to be an anonymous red
      // cube, close enough to show its compact purpose/cost prompt but outside
      // its automatic purchase radius.
      const helltide = await import('./src/helltide.js');
      helltide.triggerHelltide();
      s.run.helltideEmbersBanked = 20;
      const gift = helltide._debugSpawnTorturedGift(hx + 3.4, hz);
      if (!gift) throw new Error('authored Tortured Gift did not spawn');
      // Deterministically force one pooled weapon relic so the old anonymous
      // flat square cannot regress unnoticed.
      const weaponDrops = await import('./src/forestWeaponDrops.js');
      const random = Math.random;
      Math.random = () => 0;
      try { weaponDrops.dropForestWeapon({ x: hx, z: hz + 3.4 }, { elite: true }); }
      finally { Math.random = random; }
      s.camera.position.set(hx + 40, 60, hz + 40);
      s.camera.lookAt(hx, 0, hz);
      s.camera.updateMatrixWorld(true);
      window.__kkVisualTarPos = { x: tarPos.x, z: tarPos.z };
      window.__kkVisualHeroPos = { x: hx, z: hz };
    });
    await page.waitForTimeout(1600);

    // Spawn transient combat art only after the long decode settle so it is
    // still inside its authored animation envelope for the screenshot.
    await page.evaluate(async () => {
      const s = window.kkState;
      const p = window.__kkVisualHeroPos;
      const nova = await import('./src/fx/novaBurst.js');
      const hostile = await import('./src/enemyProjectiles.js');
      nova.spawnNovaBurst(p.x, p.z, 6.2, 3);
      hostile.clearEnemyProjectiles();
      hostile.spawnEnemyProjectile(p.x + 3.4, 0.9, p.z + 0.5, 1, 0, 999, 'magic', 1, 0);
    });
    await page.waitForTimeout(150);

    const baseline = await page.evaluate(() => {
      const s = window.kkState;
      let burger = null, halo = null, tar = null;
      let pawCore = null, pawIceCore = null;
      let novaSeal = null, novaShards = null, enemyBoltCore = null, enemyBoltHalo = null;
      let weaponRelic = null, weaponMarker = null, chestMarker = null, coffinMarker = null, shrineBeacon = null;
      const pickupAuras = [];
      const legacyPickupRadiusFields = [];
      let shrineGroundRuneCount = 0;
      s.scene.traverse((o) => {
        if (o.userData?.visualRole === 'player_weapon' && o.userData?.weaponId === 'orbitals') burger = o;
        if (o.userData?.visualRole === 'player_field' && o.userData?.weaponId === 'orbitals') halo = o;
        if (o.userData?.envHazardKind === 'tar_pit') tar = o;
        if (o.userData?.gameplayPurpose === 'bonus-pickup-radius') legacyPickupRadiusFields.push(o);
        if (o.userData?.visualRole === 'player_projectile' && o.userData?.weaponId === 'autoaim'
            && o.userData?.part === 'core' && o.userData?.variant === 'normal') pawCore = o;
        if (o.userData?.visualRole === 'player_projectile' && o.userData?.weaponId === 'autoaim'
            && o.userData?.part === 'core' && o.userData?.variant === 'ice') pawIceCore = o;
        if (o.userData?.visualRole === 'active_nova' && o.userData?.gameplayPurpose === 'damage-radius') novaSeal = o;
        if (o.userData?.visualRole === 'active_nova' && o.userData?.asset === 'nova_claw_shard.glb') novaShards = o;
        if (o.userData?.visualRole === 'enemy_projectile' && o.userData?.part === 'core') enemyBoltCore = o;
        if (o.userData?.visualRole === 'enemy_projectile' && o.userData?.part === 'halo') enemyBoltHalo = o;
        if (o.userData?.asset === 'pickup_weapon_relic') weaponRelic = o;
        if (o.userData?.pickupPart === 'weaponDropMarker') weaponMarker = o;
        if (o.userData?.chestPart === 'rewardMarker') chestMarker = o;
        if (o.userData?.coffinKind === 'rewardMarker') coffinMarker = o;
        if (o.userData?.landmarkKind === 'shrine_paw_beacon') shrineBeacon = o;
        if (o.userData?.landmarkKind === 'shrine_ground_rune') shrineGroundRuneCount++;
        if (o.userData?.visualRole === 'interactive_pickup_aura') pickupAuras.push(o);
      });
      const giftGroup = s.scene.getObjectByName('helltide:TorturedGift');
      const giftArt = s.scene.getObjectByName('helltide:TorturedGift:art');
      const info = (mesh) => {
        const image = mesh?.material?.map?.image;
        return {
          src: image?.currentSrc || image?.src || '',
          width: image?.naturalWidth || image?.width || 0,
          height: image?.naturalHeight || image?.height || 0,
          renderOrder: mesh?.renderOrder,
          bloom: !!(mesh && (mesh.layers.mask & 2)),
          depthTest: mesh?.material?.depthTest,
          depthWrite: mesh?.material?.depthWrite,
          type: mesh?.geometry?.type || '',
          count: mesh?.count ?? null,
          visible: mesh?.visible,
          opacity: mesh?.material?.opacity,
        };
      };
      return {
        burger: info(burger),
        halo: info(halo),
        tar: info(tar),
        xp: info(s.gems.instMesh),
        xpGlint: (() => {
          let hit = null;
          s.scene.traverse((o) => { if (o.userData?.visualRole === 'xp_pickup_glint') hit = o; });
          return info(hit);
        })(),
        pawCore: info(pawCore),
        pawIceCore: info(pawIceCore),
        novaSeal: info(novaSeal),
        novaShards: { ...info(novaShards), asset: novaShards?.userData?.asset || '' },
        enemyBoltCore: info(enemyBoltCore),
        enemyBoltHalo: info(enemyBoltHalo),
        weaponRelic: { ...info(weaponRelic), purpose: weaponRelic?.userData?.purpose || '' },
        weaponMarker: { ...info(weaponMarker), asset: weaponMarker?.userData?.asset || '', purpose: weaponMarker?.userData?.gameplayPurpose || '' },
        chestMarker: { ...info(chestMarker), asset: chestMarker?.userData?.asset || '', purpose: chestMarker?.userData?.gameplayPurpose || '' },
        coffinMarker: { ...info(coffinMarker), asset: coffinMarker?.userData?.asset || '', purpose: coffinMarker?.userData?.gameplayPurpose || '' },
        shrineBeacon: info(shrineBeacon),
        pickupAuras: pickupAuras.map((o) => ({
          ...info(o),
          asset: o.userData?.asset || '',
          purpose: o.userData?.gameplayPurpose || '',
        })),
        cabinPresentDuringRun: !!s.scene.getObjectByName('interiorGroup'),
        gift: {
          ...info(giftArt),
          interactive: giftGroup?.userData?.interactive === true,
          purpose: giftGroup?.userData?.gameplayPurpose || '',
          name: giftGroup?.name || '',
        },
        giftPrompt: (() => {
          const el = document.getElementById('kk-helltide-gift-prompt');
          return el ? { visible: getComputedStyle(el).display !== 'none', text: el.textContent, fontSize: getComputedStyle(el).fontSize } : null;
        })(),
        legacyPickupRadiusFieldCount: legacyPickupRadiusFields.length,
        shrineGroundRuneCount,
        render: { calls: s.renderer.info.render.drawCalls, triangles: s.renderer.info.render.triangles },
      };
    });

    const assetChecks = [
      ['burger', baseline.burger, /cheesy_burger\.webp/, 512],
      ['tar', baseline.tar, /tar_bog\.webp/, 512],
      ['xp', baseline.xp, /xp_paw_crystal\.webp/, 256],
      ['pawCore', baseline.pawCore, /paw_comet\.webp/, 256],
      ['pawIceCore', baseline.pawIceCore, /paw_comet\.webp/, 256],
      ['novaSeal', baseline.novaSeal, /nova_pawburst\.webp/, 512],
      ['enemyBoltCore', baseline.enemyBoltCore, /enemy_cat_spirit_bolt\.webp/, 256],
      ['weaponRelic', baseline.weaponRelic, /weapon_relic_drop\.webp/, 256],
      ['weaponMarker', baseline.weaponMarker, /pickup_paw_aura\.webp/, 512],
      ['chestMarker', baseline.chestMarker, /pickup_paw_aura\.webp/, 512],
      ['coffinMarker', baseline.coffinMarker, /pickup_paw_aura\.webp/, 512],
      ['pickupAura', baseline.pickupAuras[0] || {}, /pickup_paw_aura\.webp/, 512],
      ['gift', baseline.gift, /helltide_tortured_gift\.webp/, 512],
    ];
    for (const [name, row, re, min] of assetChecks) {
      if (!re.test(row.src) || row.width < min || row.height < min) failures.push(`${name} asset not decoded: ${JSON.stringify(row)}`);
    }
    if (baseline.burger.type !== 'PlaneGeometry' || baseline.burger.count < 2) failures.push(`burger pool invalid: ${JSON.stringify(baseline.burger)}`);
    if (!baseline.burger.depthTest || !baseline.burger.depthWrite || baseline.burger.bloom) failures.push(`burger layering invalid: ${JSON.stringify(baseline.burger)}`);
    if (baseline.xp.type !== 'PlaneGeometry' || !baseline.xp.depthTest || !baseline.xp.depthWrite || baseline.xp.bloom) failures.push(`XP layering invalid: ${JSON.stringify(baseline.xp)}`);
    if (baseline.tar.renderOrder !== -7 || baseline.tar.depthWrite || baseline.tar.bloom) failures.push(`tar layering invalid: ${JSON.stringify(baseline.tar)}`);
    if (baseline.halo.renderOrder !== -5 || baseline.halo.bloom) failures.push(`orbital halo layering invalid: ${JSON.stringify(baseline.halo)}`);
    if (!baseline.pawCore.depthTest || baseline.pawCore.depthWrite || baseline.pawCore.bloom || baseline.pawCore.type !== 'PlaneGeometry') failures.push(`paw-comet core layering invalid: ${JSON.stringify(baseline.pawCore)}`);
    if (!baseline.pawIceCore.visible) failures.push(`ice paw-comet pool was not exercised: ${JSON.stringify(baseline.pawIceCore)}`);
    if (baseline.novaSeal.renderOrder !== -5 || baseline.novaSeal.bloom || !baseline.novaSeal.depthTest || baseline.novaSeal.depthWrite) failures.push(`Nova seal layering invalid: ${JSON.stringify(baseline.novaSeal)}`);
    if (baseline.novaShards.asset !== 'nova_claw_shard.glb' || baseline.novaShards.count !== 12) failures.push(`Blender Nova shard pool invalid: ${JSON.stringify(baseline.novaShards)}`);
    if (baseline.enemyBoltCore.type !== 'PlaneGeometry' || baseline.enemyBoltCore.count !== 1 || baseline.enemyBoltCore.bloom || !baseline.enemyBoltCore.depthTest || baseline.enemyBoltCore.depthWrite) failures.push(`enemy bolt core pool invalid: ${JSON.stringify(baseline.enemyBoltCore)}`);
    if (baseline.enemyBoltHalo.count !== 1 || !baseline.enemyBoltHalo.bloom) failures.push(`enemy bolt halo pool invalid: ${JSON.stringify(baseline.enemyBoltHalo)}`);
    if (baseline.weaponRelic.type !== 'PlaneGeometry' || baseline.weaponRelic.count !== 1
        || !baseline.weaponRelic.depthTest || baseline.weaponRelic.depthWrite
        || baseline.weaponRelic.bloom || baseline.weaponRelic.purpose !== 'interactive weapon pickup') {
      failures.push(`weapon relic pool/purpose invalid: ${JSON.stringify(baseline.weaponRelic)}`);
    }
    for (const [name, marker, purpose] of [
      ['weapon', baseline.weaponMarker, 'walk-over weapon reward'],
      ['chest', baseline.chestMarker, 'walk-over treasure chest'],
      ['coffin', baseline.coffinMarker, 'walk-to evolution coffin'],
    ]) {
      if (marker.type !== 'PlaneGeometry' || marker.bloom || !marker.depthTest
          || marker.depthWrite || marker.renderOrder !== -5 || marker.asset !== 'pickup_paw_aura'
          || marker.purpose !== purpose) {
        failures.push(`${name} reward marker invalid: ${JSON.stringify(marker)}`);
      }
    }
    if (baseline.pickupAuras.length !== 3 || baseline.pickupAuras.some((a) =>
      a.type !== 'PlaneGeometry' || a.count !== 1 || a.bloom
      || a.renderOrder !== -5 || a.depthWrite
      || a.asset !== 'pickup_paw_aura' || a.purpose !== 'walk-over consumable')) {
      failures.push(`Forest pickup aura contract invalid: ${JSON.stringify(baseline.pickupAuras)}`);
    }
    if (baseline.cabinPresentDuringRun) failures.push('cabin interior was eagerly built during a combat run');
    if (!baseline.gift.interactive || !/Spend 50 Helltide Embers/.test(baseline.gift.purpose)
        || !baseline.gift.depthTest || !baseline.gift.depthWrite) failures.push(`Tortured Gift purpose/layering invalid: ${JSON.stringify(baseline.gift)}`);
    if (!baseline.giftPrompt?.visible || !/NEED 30 MORE/.test(baseline.giftPrompt.text || '')
        || parseFloat(baseline.giftPrompt.fontSize) > 12) failures.push(`Tortured Gift prompt invalid: ${JSON.stringify(baseline.giftPrompt)}`);
    if (baseline.legacyPickupRadiusFieldCount !== 0) failures.push(`legacy pickup radius ring is still in scene: ${baseline.legacyPickupRadiusFieldCount}`);
    if (baseline.shrineGroundRuneCount !== 0 || baseline.shrineBeacon.count < 1) {
      failures.push(`shrine marker regression: ${JSON.stringify({ runes: baseline.shrineGroundRuneCount, beacon: baseline.shrineBeacon })}`);
    }
    if (baseline.render.calls > 470 || baseline.render.triangles > 1_600_000) failures.push(`render budget exceeded: ${JSON.stringify(baseline.render)}`);

    await page.screenshot({ path: '/tmp/kks-forest-combat-visuals.png' });
    const bonusState = await page.evaluate(async () => {
      const s = window.kkState;
      s.hero.statMul.magnet = 1.25;
      const orbital = s.weapons.find((w) => w.id === 'orbitals');
      if (orbital) { orbital.inst.evolved = true; orbital.inst._tinted = false; }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      let burger = null;
      let legacyRadiusFields = 0;
      s.scene.traverse((o) => { if (o.userData?.gameplayPurpose === 'bonus-pickup-radius') legacyRadiusFields++; });
      s.scene.traverse((o) => { if (o.userData?.visualRole === 'player_weapon' && o.userData?.weaponId === 'orbitals') burger = o; });
      const image = burger?.material?.map?.image;
      return {
        legacyRadiusFields,
        evolvedBurgerSrc: image?.currentSrc || image?.src || '',
        evolvedBurgerWidth: image?.naturalWidth || image?.width || 0,
      };
    });
    if (bonusState.legacyRadiusFields !== 0) {
      failures.push(`magnet upgrade recreated a legacy radius ring: ${JSON.stringify(bonusState)}`);
    }
    if (!/cheesy_burger_toxic\.webp/.test(bonusState.evolvedBurgerSrc || '') || bonusState.evolvedBurgerWidth < 512) {
      failures.push(`toxic burger asset not decoded: ${JSON.stringify(bonusState)}`);
    }
    await page.screenshot({ path: '/tmp/kks-forest-combat-bonus-pickup-free.png' });

    // The cabin is now constructed on demand. Verify that the optimization
    // did not break entering it and that exiting removes it from rendering.
    const cabinLifecycle = await page.evaluate(async () => {
      const s = window.kkState;
      const interior = await import('./src/interior.js');
      const group = interior.buildInterior(s.scene);
      interior.enterInterior();
      const entered = {
        present: s.scene.getObjectByName('interiorGroup') === group,
        visible: group.visible,
        mode: s.mode,
      };
      interior.exitInterior();
      return {
        entered,
        exited: { visible: group.visible, y: group.position.y, mode: s.mode },
      };
    });
    if (!cabinLifecycle.entered.present || !cabinLifecycle.entered.visible
        || cabinLifecycle.entered.mode !== 'interior'
        || cabinLifecycle.exited.visible || cabinLifecycle.exited.y !== -200
        || cabinLifecycle.exited.mode !== 'town') {
      failures.push(`lazy cabin lifecycle invalid: ${JSON.stringify(cabinLifecycle)}`);
    }
    if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);

    console.log(JSON.stringify({ baseline, bonusState, cabinLifecycle, screenshots: ['/tmp/kks-forest-combat-visuals.png', '/tmp/kks-forest-combat-bonus-pickup-free.png'] }, null, 2));
    if (failures.length) {
      console.error('[smoke-forest-combat-visuals] FAIL\n- ' + failures.join('\n- '));
      process.exitCode = 1;
    } else {
      console.log('[smoke-forest-combat-visuals] PASS');
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error('[smoke-forest-combat-visuals] FATAL', e);
  process.exitCode = 1;
  try { server.close(); } catch (_) {}
});
