#!/usr/bin/env node
/**
 * Casino presentation/progression source smoke.
 *
 * Guards the cheap-placeholder regression class without launching WebGL:
 * authored canvas signs/reels, bounded instancing, cached frame animation,
 * physical VIP/Vault ownership dressing, and finished compact casino UI.
 *
 * Run: node tools/smoke-casino-polish.mjs
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const interior = read('src/casinoInterior.js');
const ui = read('src/ui.js');

let pass = 0;
function ok(message) { pass++; console.log(`[OK] ${message}`); }

assert.match(interior, /function _makeFloorTexture\(/, 'casino floor canvas texture missing');
assert.match(interior, /function _makePlaqueTexture\(/, 'authored plaque texture builder missing');
assert.match(interior, /SEEDY TENT[\s\S]*LUCK\s+•\s+LOOT/, 'Seedy Tent sign is not authored/legible');
assert.match(interior, /RETURN TO TOWN/, 'exit plaque is not legible');
assert.match(interior, /function _makeSlotScreenTexture\(/, 'slot screen texture builder missing');
assert.match(interior, /casino_slot_screen/, 'authored slot screen was not installed');
ok('floor, Seedy Tent plaque, exit plaque, and slot reels are authored canvas visuals');

assert.match(interior, /new THREE\.InstancedMesh\([\s\S]*?VAULT_COIN_CAP/, 'Vault hoard is not instanced/bounded');
assert.match(interior, /const VAULT_COIN_CAP\s*=\s*48/, 'Vault hoard cap changed unexpectedly');
assert.match(interior, /texturedFloorDraws:\s*1/, 'single-draw textured floor marker missing');
assert.doesNotMatch(interior, /for\s*\(let j\s*=\s*0;\s*j\s*<\s*4/, 'old 24-mesh checker floor returned');
ok('new room density remains bounded (one floor draw, 48 instanced Vault coins)');

assert.match(interior, /casinoVipDressing/, 'VIP physical dressing missing');
assert.match(interior, /casinoVaultDressing/, 'Vault physical dressing missing');
assert.match(interior, /house\.vip_multipliers/, 'VIP ownership is not synchronized into the room');
assert.match(interior, /house\.vault_decor/, 'Vault ownership is not synchronized into the room');
assert.match(interior, /casinoLifetimeWon/, 'Vault does not scale from lifetime winnings');
assert.match(interior, /casinoSlotsBigWins/, 'jackpot marquee does not reflect lifetime jackpots');
ok('casino upgrades and lifetime play visibly evolve the walkable room');

assert.doesNotMatch(interior, /_group\.traverse\(/, 'casino still traverses the room every frame');
assert.match(interior, /_slotScreenMat\.emissiveIntensity/, 'cached slot material animation missing');
assert.match(interior, /ROOM_STATE_POLL_SEC\s*=\s*0\.5/, 'room progression polling is not throttled');
ok('animation uses cached references and throttled progression polling');

assert.doesNotMatch(ui, /upcoming iters|upcoming iteration/i, 'unfinished casino roadmap copy remains visible');
assert.match(ui, /THE ROOM REMEMBERS/, 'finished physical-upgrade explanation missing');
assert.match(ui, /const meta = getMeta\(\);[\s\S]*?const sigils = meta\.sigils/, 'casino dashboard is not using canonical meta state');
assert.doesNotMatch(ui.slice(ui.indexOf('export function showCasinoMenu'), ui.indexOf('export function showCasinoParlay')), /\* 40px/, 'casino dashboard still uses oversized 40px text');
ok('casino UI is finished, save-correct, and compact');

console.log(`\npass=${pass} fail=0`);
console.log('ALL CHECKS PASS');
