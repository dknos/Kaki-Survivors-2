#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { rallyAssetIds, RALLY_ASSET_MANIFEST } from '../src/racing/racingManifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VEHICLE_FILE = path.join(ROOT, 'assets/racing/crash/kaki-catastrophe-vehicles-v2.glb');
const ENVIRONMENT_FILE = path.join(ROOT, 'assets/racing/crash/pawprint-moonpaw-environment-v2.glb');
const DAMAGE_TARGETS = ['DamageFront', 'DamageRear', 'DamageLeft', 'DamageRight'];
let assertions = 0;

function check(value, message) {
  assertions += 1;
  if (!value) throw new Error(message);
}

function parseGlb(file) {
  const buffer = fs.readFileSync(file);
  check(buffer.toString('ascii', 0, 4) === 'glTF', `${path.basename(file)} must be a GLB`);
  check(buffer.readUInt32LE(4) === 2, `${path.basename(file)} must use glTF 2`);
  check(buffer.readUInt32LE(8) === buffer.length, `${path.basename(file)} has an invalid byte length`);
  const jsonLength = buffer.readUInt32LE(12);
  check(buffer.toString('ascii', 16, 20) === 'JSON', `${path.basename(file)} must begin with JSON`);
  return JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength).replace(/\0+$/, '').trim());
}

function baseName(name = '') {
  return String(name).replace(/\.\d{3}$/, '');
}

function nodeIndex(json, name) {
  return json.nodes.findIndex((node) => node.name === name);
}

function descendants(json, rootIndex) {
  const result = [];
  const pending = [rootIndex];
  const seen = new Set();
  while (pending.length) {
    const index = pending.pop();
    if (seen.has(index) || !json.nodes[index]) continue;
    seen.add(index);
    result.push(json.nodes[index]);
    pending.push(...(json.nodes[index].children || []));
  }
  return result;
}

function requireNamedPart(nodes, name, owner) {
  check(nodes.some((node) => baseName(node.name) === name), `${owner} is missing ${name}`);
}

function validateDamageSurfaces(json, nodes, owner) {
  const damageNodes = nodes.filter((node) => node.extras?.role === 'authored-damage-surface');
  check(damageNodes.length > 0, `${owner} has no authored damage surface`);
  for (const node of damageNodes) {
    const mesh = json.meshes[node.mesh];
    check(!!mesh, `${owner}/${node.name} has no mesh`);
    check(JSON.stringify(mesh.extras?.targetNames) === JSON.stringify(DAMAGE_TARGETS), `${owner}/${node.name} has the wrong damage targets`);
    check((mesh.primitives || []).every((primitive) => primitive.targets?.length === DAMAGE_TARGETS.length), `${owner}/${node.name} lacks four deformation morphs`);
  }
}

function validateWheelSockets(nodes, owner, exactFour = false) {
  const sockets = nodes.filter((node) => node.extras?.role === 'wheel-socket');
  check(exactFour ? sockets.length === 4 : sockets.length >= 4, `${owner} has ${sockets.length} authored wheel sockets`);
  const order = new Set(sockets.map((node) => node.extras?.wheel_order));
  for (const name of ['left-front-wheel', 'right-front-wheel']) {
    check(order.has(name), `${owner} is missing ordered socket ${name}`);
  }
  check([...order].some((name) => /^left-rear(?:-|$)/.test(name)), `${owner} is missing a left rear wheel socket`);
  check([...order].some((name) => /^right-rear(?:-|$)/.test(name)), `${owner} is missing a right rear wheel socket`);
  for (const socket of sockets) {
    check((socket.translation || []).every(Number.isFinite), `${owner}/${socket.name} has a non-finite transform`);
  }
}

function validateVehicleFleet(json) {
  const sceneExtras = json.scenes?.[json.scene || 0]?.extras || {};
  check(sceneExtras.assetName === 'Kaki Catastrophe vehicle fleet v2', 'vehicle fleet metadata is missing');
  check(sceneExtras.license === 'Project-owned original', 'vehicle fleet must be marked project-owned');
  check(sceneExtras.vehicleCount === 14, 'vehicle fleet metadata must declare all 14 silhouettes');
  check(sceneExtras.forwardAxis === '+Z', 'vehicle fleet must use +Z forward');

  const players = ['PocketPouncer', 'KakiMuscle', 'IronTabby'];
  const productionParts = [
    'hood', 'trunk', 'left-door', 'right-door', 'front-bumper', 'rear-bumper',
    'left-mirror', 'right-mirror', 'windshield-glass', 'rear-window-glass',
    'cockpit-canopy', 'cockpit-headliner', 'cockpit-floor', 'dashboard',
    'steering-wheel', 'windshield-frame-left', 'windshield-frame-right',
    'windshield-frame-top', 'cockpit-hood-view', 'driver-eye-socket',
  ];
  for (const id of players) {
    const owner = `KakiCat_Player_${id}`;
    const root = nodeIndex(json, owner);
    check(root >= 0, `missing player silhouette ${owner}`);
    const nodes = descendants(json, root);
    for (const part of productionParts) requireNamedPart(nodes, part, owner);
    check(nodes.find((node) => baseName(node.name) === 'driver-eye-socket')?.extras?.role === 'driver-eye-socket', `${owner} has no tagged driver eye`);
    validateWheelSockets(nodes, owner, true);
    validateDamageSurfaces(json, nodes, owner);
  }

  const traffic = [
    'Sedan', 'Hatchback', 'Wagon', 'Pickup', 'SUV', 'Van',
    'BoxTruck', 'Bus', 'SemiTractor', 'SemiTrailer', 'Tanker',
  ];
  const classes = new Set();
  for (const id of traffic) {
    const owner = `KakiCat_Traffic_${id}`;
    const root = nodeIndex(json, owner);
    check(root >= 0, `missing traffic silhouette ${owner}`);
    const nodes = descendants(json, root);
    const vehicleClass = json.nodes[root].extras?.vehicle_class;
    check(vehicleClass && !classes.has(vehicleClass), `${owner} must have a unique vehicle class`);
    classes.add(vehicleClass);
    validateWheelSockets(nodes, owner);
    validateDamageSurfaces(json, nodes, owner);
  }

  const silhouetteDetails = new Map([
    ['KakiCat_Traffic_Hatchback', ['KakiCat_Traffic_Hatchback-roof-spoiler']],
    ['KakiCat_Traffic_Wagon', ['KakiCat_Traffic_Wagon-roof-rail-L', 'KakiCat_Traffic_Wagon-roof-rail-R']],
    ['KakiCat_Traffic_Pickup', ['KakiCat_Traffic_Pickup-pickup-bed-floor', 'KakiCat_Traffic_Pickup-bed-rail-L']],
    ['KakiCat_Traffic_SUV', ['KakiCat_Traffic_SUV-roof-rail-L']],
    ['KakiCat_Traffic_Van', ['KakiCat_Traffic_Van-roof-pod', 'KakiCat_Traffic_Van-sliding-door-track']],
    ['KakiCat_Traffic_BoxTruck', ['KakiCat_Traffic_BoxTruck-cab', 'KakiCat_Traffic_BoxTruck-cargo-box']],
    ['KakiCat_Traffic_Bus', ['KakiCat_Traffic_Bus-bus-body', 'KakiCat_Traffic_Bus-window-L-0']],
    ['KakiCat_Traffic_SemiTractor', ['KakiCat_Traffic_SemiTractor-cab', 'KakiCat_Traffic_SemiTractor-exhaust-L']],
    ['KakiCat_Traffic_SemiTrailer', ['KakiCat_Traffic_SemiTrailer-cargo', 'KakiCat_Traffic_SemiTrailer-chassis']],
    ['KakiCat_Traffic_Tanker', ['KakiCat_Traffic_Tanker-tank', 'KakiCat_Traffic_Tanker-tank-band-0']],
  ]);
  for (const [owner, required] of silhouetteDetails) {
    const names = new Set(descendants(json, nodeIndex(json, owner)).map((node) => baseName(node.name)));
    for (const name of required) check(names.has(name), `${owner} is missing silhouette detail ${name}`);
  }
}

function validateEnvironment(json) {
  const extras = json.scenes?.[json.scene || 0]?.extras || {};
  check(extras.assetName === 'Pawprint Interchange / Moonpaw Freight District v2', 'environment metadata is missing');
  check(extras.license === 'Project-owned original', 'environment must be marked project-owned');
  check(extras.runtimeExternalRequests === false, 'environment must forbid runtime external requests');
  check(/COLLIDER/.test(extras.collisionSource || ''), 'environment must identify its authored collision source');
  const names = new Set(json.nodes.map((node) => node.name));
  for (const name of [
    'Road_NS_Authored', 'Road_EW_Authored', 'Road_Player_Approach_Authored',
    'COLLIDER_Road_NS', 'COLLIDER_Road_EW', 'COLLIDER_Road_Player_Approach',
    'Ramp_West_Authored', 'Ramp_East_Authored', 'COLLIDER_Ramp_West', 'COLLIDER_Ramp_East',
    'Landmark_Paw_Gateway', 'Landmark_Elevated_Monorail', 'Moonpaw_Monorail_Train',
    'Landmark_Moonpaw_Energy_Depot', 'Landmark_Crown_City_Skyline',
    'Moonpaw_Workshops_SW', 'Moonpaw_Stores_NW', 'Moonpaw_Apartments_SE', 'Moonpaw_Depot_Offices_NE',
    'COLLIDER_Moonpaw_Workshops_SW', 'COLLIDER_Moonpaw_Stores_NW',
    'COLLIDER_Moonpaw_Apartments_SE', 'COLLIDER_Moonpaw_Depot_Offices_NE',
    'BREAKABLE_Moonpaw_Scaffold', 'Moonpaw_Batch_road_marking', 'Moonpaw_Batch_road_wear',
  ]) check(names.has(name), `environment is missing ${name}`);
  check([...names].filter((name) => name.startsWith('BREAKABLE_BusShelter_')).length >= 4, 'environment needs four destructible bus shelters');
  check([...names].filter((name) => name.startsWith('BREAKABLE_RoadsideEquipment_')).length >= 4, 'environment needs destructible roadside equipment');
  check([...names].filter((name) => name.startsWith('BREAKABLE_TrafficSignal_')).length === 4, 'environment needs four physical traffic signals');
  check([...names].filter((name) => name.startsWith('Atmosphere_SteamVent_')).length >= 4, 'environment needs drain steam');
  check([...names].filter((name) => name.startsWith('Atmosphere_GroundFog_')).length >= 3, 'environment needs ground fog');
  check([...names].filter((name) => name.startsWith('Atmosphere_DistantRain_')).length >= 3, 'environment needs distant rain');
  check([...names].filter((name) => name.startsWith('CloudLayer_')).length >= 5, 'environment needs layered moving clouds');
  const materials = new Set((json.materials || []).map((material) => material.name));
  for (const material of ['Moonpaw_Wet_Asphalt', 'Moonpaw_Puddles', 'Moonpaw_Asphalt_Repairs', 'Moonpaw_Asphalt_Cracks', 'Moonpaw_Tire_Rubber_Marks', 'Moonpaw_Oil_Stains']) {
    check(materials.has(material), `environment is missing authored material ${material}`);
  }
}

function validateRuntimeBoundary() {
  const crashAssets = rallyAssetIds('forest', 'crash');
  check(JSON.stringify(crashAssets) === JSON.stringify(['decalAtlas', 'crashVehicleKitV2', 'crashEnvironmentV2', 'skyTwilight']), 'Catastrophe working set contains a legacy asset');
  for (const id of crashAssets) {
    const url = RALLY_ASSET_MANIFEST[id]?.url || '';
    check(url && !/^(?:https?:)?\/\//i.test(url), `Catastrophe asset ${id} is not local-only`);
  }
  const crashDir = path.join(ROOT, 'src/racing/crash');
  const sources = fs.readdirSync(crashDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(crashDir, name), 'utf8'))
    .join('\n');
  check(!sources.includes('arena-traffic-kit-v1.glb'), 'Catastrophe source references the retired arena traffic kit');
  check(!sources.includes("whenReady?.('arenaTrafficKit')"), 'Catastrophe still requests the arena traffic kit');
  const worldSource = fs.readFileSync(path.join(crashDir, 'crashWorld.js'), 'utf8');
  check(!worldSource.includes('BoxGeometry'), 'primary Catastrophe roads/buildings must not be runtime BoxGeometry');
  const damageSource = fs.readFileSync(path.join(crashDir, 'crashDamagePresentation.js'), 'utf8');
  check(!/productionModel\.visible\s*=\s*false/.test(damageSource), 'damage must never hide the production vehicle');
}

try {
  validateVehicleFleet(parseGlb(VEHICLE_FILE));
  validateEnvironment(parseGlb(ENVIRONMENT_FILE));
  validateRuntimeBoundary();
  console.log(`Kaki Catastrophe authored-asset validation passed: ${assertions} assertions.`);
} catch (error) {
  console.error(`Kaki Catastrophe authored-asset validation failed: ${error.message}`);
  process.exitCode = 1;
}
