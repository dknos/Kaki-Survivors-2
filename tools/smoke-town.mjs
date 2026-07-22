#!/usr/bin/env node
/**
 * Town hub smoke (CC3 town cohort 1, 2026-05-20).
 *
 * Static-source gate (mirrors tools/smoke-sig-weapons.mjs) — town interaction
 * needs hero movement into an interactable radius + a keydown, which is not
 * worth driving headless. Instead we assert the WIRING that cohort 1 added:
 *   1. town.js declares the Shop + Grimoire interactables.
 *   2. town.js wires _handlers.shop + _handlers.grimoire to the ui modals
 *      (dynamic import of ui.js — the menuV2 pattern).
 *   3. town.js builds + places the Grimoire lectern mesh.
 *   4. enterTown() bumps a persistent townVisits counter (acceptance:
 *      "persistent visit state").
 *   5. ui.js exports showShop + showGrimoire (the openers the handlers call).
 *
 * CC5 town cohort 2 (2026-05-20) adds the wandering sage NPC:
 *   6. chatBubble.js exposes the setSpeakerAnchor seam; town.js builds the NPC,
 *      anchors + speaks its bubble via chatBubble, ticks it from tickTown, and
 *      keys its first line off the townVisits counter (returning-player dressing).
 *
 * Run: node tools/smoke-town.mjs   (no flags, no server, no playwright)
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let pass = 0;
function ok(msg) { pass++; console.log(`[OK] ${msg}`); }

const town = read('src/town.js');
const ui = read('src/ui.js');
const main = read('src/main.js');
const assets = read('src/assets.js');
const interior = read('src/interior.js');
const casinoInterior = read('src/casinoInterior.js');

// 1: interactables present
assert.ok(/key:\s*'shop'/.test(town), "town.js: shop interactable missing");
assert.ok(/key:\s*'grimoire'/.test(town), "town.js: grimoire interactable missing");
assert.ok(!/Shop \(coming soon\)/.test(town), "town.js: shop still labelled 'coming soon'");
ok('shop + grimoire interactables declared (shop no longer "coming soon")');

// 2: handlers wired to the ui modals via dynamic import
assert.ok(/_handlers\.shop\s*=/.test(town), "town.js: _handlers.shop not wired");
assert.ok(/_handlers\.grimoire\s*=/.test(town), "town.js: _handlers.grimoire not wired");
assert.ok(/import\('\.\/ui\.js'\)[\s\S]*showShop/.test(town), "town.js: shop handler does not open showShop via dynamic import");
assert.ok(/import\('\.\/ui\.js'\)[\s\S]*showGrimoire/.test(town), "town.js: grimoire handler does not open showGrimoire via dynamic import");
ok('shop + grimoire handlers open ui modals via dynamic import');

// 3: Grimoire lectern mesh built + placed
assert.ok(/function _makeGrimoirePedestal\(/.test(town), "town.js: _makeGrimoirePedestal builder missing");
assert.ok(/_makeGrimoirePedestal\(\)/.test(town), "town.js: grimoire pedestal never instantiated");
ok('grimoire lectern mesh built + placed');

// 4: persistent visit state
assert.ok(/setOption\('townVisits'/.test(town), "town.js: enterTown does not persist townVisits");
ok('enterTown persists townVisits counter');

// 5: ui openers exist
assert.ok(/export function showShop\(/.test(ui), "ui.js: showShop export missing");
assert.ok(/export function showGrimoire\(/.test(ui), "ui.js: showGrimoire export missing");
ok('ui.js exports showShop + showGrimoire');

// 6: CC5 town cohort 2 — wandering sage NPC reusing chatBubble.js
const chat = read('src/chatBubble.js');
assert.ok(/export function setSpeakerAnchor\(/.test(chat), "chatBubble.js: setSpeakerAnchor seam missing");
assert.ok(/from '\.\/chatBubble\.js'[\s\S]*?\bsetSpeakerAnchor\b/.test(town) || /\bsetSpeakerAnchor\b[\s\S]*?from '\.\/chatBubble\.js'/.test(town), "town.js: setSpeakerAnchor not imported from chatBubble");
assert.ok(/function _makeTownNpc\(/.test(town), "town.js: _makeTownNpc builder missing");
assert.ok(/_makeTownNpc\(\)/.test(town), "town.js: NPC never instantiated");
assert.ok(/setSpeakerAnchor\(\s*NPC_SPEAKER_ID/.test(town), "town.js: NPC bubble anchor not registered");
assert.ok(/pushBubble\(\s*NPC_SPEAKER_ID/.test(town), "town.js: NPC never speaks via pushBubble");
assert.ok(/function _tickNpc\(/.test(town), "town.js: _tickNpc wander/bark scheduler missing");
assert.ok(/_tickNpc\(dt\)/.test(town), "town.js: _tickNpc not called from tickTown");
assert.ok(/visits\s*>\s*1/.test(town) && /Back again/.test(town), "town.js: NPC first bark not keyed off townVisits (returning-player dressing)");
ok('wandering sage NPC: setSpeakerAnchor seam + builder + anchor + townVisits-keyed bark + tickTown wire');

// 7: CC6 town cohort 3 — biome gate dressing keyed off selectedStage
assert.ok(/const _GATE_BIOME\s*=/.test(town), "town.js: _GATE_BIOME map missing");
assert.ok(/_GATE_BIOME\s*=\s*\{[\s\S]*?forest:[\s\S]*?cave:/.test(town), "town.js: _GATE_BIOME missing forest/cave entries");
assert.ok(/function _makeGatePlanter\(/.test(town), "town.js: _makeGatePlanter builder missing");
assert.ok(/_makeGatePlanter\(\)/.test(town), "town.js: gate planter never instantiated");
assert.ok(/function _applyGateBiome\(/.test(town), "town.js: _applyGateBiome missing");
assert.ok(/_applyGateBiome\(getMeta\(\)\.selectedStage\)/.test(town), "town.js: gate biome not keyed off selectedStage");
// refreshed each entry: the call sits in enterTown after the townVisits bump
assert.ok(/setOption\('townVisits'[\s\S]*?_applyGateBiome\(getMeta\(\)\.selectedStage\)/.test(town), "town.js: gate biome not refreshed in enterTown");
ok('biome gate dressing: _GATE_BIOME map + planter builder + selectedStage-keyed apply (build + enterTown refresh)');

// 8: CC8 town run-launch flourish (gate-activation flare)
assert.ok(/function _triggerGateLaunch\(/.test(town), "town.js: _triggerGateLaunch missing");
assert.ok(/const GATE_FLOURISH_SEC\s*=/.test(town), "town.js: GATE_FLOURISH_SEC const missing");
// gate E now routes through the flourish, not a direct _onGateActivate() call
assert.ok(/_activeKey === 'gate' && _onGateActivate[\s\S]*?_triggerGateLaunch\(\)/.test(town), "town.js: gate interaction does not route through the launch flourish");
// portal light stored for the flare spike + the flare window read in tickTown
assert.ok(/_portalLight\s*=\s*pl/.test(town), "town.js: portal light not stored for the flare spike");
assert.ok(/_gateFlourishUntil/.test(town), "town.js: flare-window state (_gateFlourishUntil) not used in tickTown");
// CRITICAL: the real launch still fires after the flare (deferred via setTimeout) —
// guards against an orphaned flourish that never starts the run.
assert.ok(/setTimeout\([\s\S]*?_onGateActivate\(\)/.test(town), "town.js: _onGateActivate not invoked after the flare (orphaned launch)");
ok('gate-launch flourish: _triggerGateLaunch + GATE_FLOURISH_SEC + portal light spike + deferred _onGateActivate');

// 9: final chapter + authored Town surface. Kaki Land must preview its own
// cyan portal palette, and Town's AI-assisted cobble texture must be part of
// the same gated preload that builds the hub.
assert.ok(/kakiland:\s*\{/.test(town), 'town.js: Kaki Land gate-biome preview missing');
assert.ok(/getCachedTexture\('town_plaza_cobble_v1'\)/.test(town), 'town.js: generated plaza texture not consumed');
assert.ok(/town_plaza_cobble_v1\.png/.test(assets), 'assets.js: generated plaza texture not preloaded');
ok('Kaki Land gate palette + generated cobble plaza texture are wired into Town preload');

// 10: interaction is normalized through hero's edge state. This is the route
// gamepad B and the mobile contextual tap use after updateHero consumes input.
for (const [name, source] of [['town', town], ['interior', interior], ['casino interior', casinoInterior]]) {
  assert.ok(/function _activateActive\(/.test(source), `${name}: shared interaction activation helper missing`);
  assert.ok(/state\.input && state\.input\.interactPressed/.test(source), `${name}: controller/mobile interaction edge not consumed`);
}
ok('Town, house, and casino consume the normalized controller/mobile interaction edge');

// 11: leaving Town invalidates delayed work and hides world/UI residue.
assert.ok(/export function cancelGateLaunch\(/.test(town), 'town.js: cancellable gate launch missing');
assert.ok(/export function suspendTown\(/.test(town), 'town.js: visibility-only Town suspend seam missing');
assert.ok(/export function refreshTownCasinoExterior\(/.test(town), 'town.js: casino exterior upgrade seam missing');
assert.ok(/_nextHubTransition/.test(main) && /_isCurrentTransition/.test(main), 'main.js: async hub transition ownership guards missing');
assert.ok(/_canContinueRunStart/.test(main), 'main.js: paused/modal run-start cancellation guard missing');
assert.ok(/setHUDVisible\(false\)/.test(main), 'main.js: Town/Menu combat HUD teardown missing');
assert.ok(/setOrthoFrustum\(WORLD\.cameraDistance\s*\/\s*getZoom\(\)\)/.test(main)
  || /const _thalf = WORLD\.cameraDistance/.test(main),
'main.js: Town camera frustum reset missing');
ok('Town cancellation, async ownership, HUD teardown, and camera-reset seams are present');

console.log(`\npass=${pass} fail=0`);
console.log('ALL CHECKS PASS');
