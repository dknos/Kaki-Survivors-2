import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../..');
const MATERIAL_DIR = path.join(ROOT, 'src/rendering/materials');
const MODULE_NAMES = [
  'rimLightMaterial.js',
  'damageFlashMaterial.js',
  'creatureAnimationMaterial.js',
];

// Exercise the browser-native bare imports against the exact vendored r185
// package. The temporary package link avoids adding a second Three.js install
// to production and makes module identity match three/webgpu <-> three/tsl.
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-tsl-character-'));
const fixtureMaterials = path.join(fixtureRoot, 'src/rendering/materials');
await fs.mkdir(fixtureMaterials, { recursive: true });
await fs.mkdir(path.join(fixtureRoot, 'node_modules'), { recursive: true });
await fs.symlink(path.join(ROOT, 'vendor/three'), path.join(fixtureRoot, 'node_modules/three'), 'dir');
await Promise.all(MODULE_NAMES.map((name) => (
  fs.copyFile(path.join(MATERIAL_DIR, name), path.join(fixtureMaterials, name))
)));

const THREE = await import(pathToFileURL(path.join(ROOT, 'vendor/three/build/three.webgpu.js')).href);
const rim = await import(pathToFileURL(path.join(fixtureMaterials, 'rimLightMaterial.js')).href);
const damage = await import(pathToFileURL(path.join(fixtureMaterials, 'damageFlashMaterial.js')).href);
const creature = await import(pathToFileURL(path.join(fixtureMaterials, 'creatureAnimationMaterial.js')).href);

after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

test('classic standard conversion is cached and preserves render/PBR fields', () => {
  const map = new THREE.DataTexture(new Uint8Array([255, 128, 64, 255]), 1, 1);
  map.needsUpdate = true;
  const source = new THREE.MeshStandardMaterial({
    color: 0x345678,
    emissive: 0x123456,
    emissiveIntensity: 0.42,
    map,
    roughness: 0.37,
    metalness: 0.61,
    transparent: true,
    opacity: 0.72,
    alphaTest: 0.15,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  source.normalMap = map;
  source.normalScale.set(0.55, 0.8);
  source.roughnessMap = map;
  source.metalnessMap = map;
  source.emissiveMap = map;
  source.aoMap = map;
  source.aoMapIntensity = 0.65;
  source.alphaMap = map;
  source.envMap = map;
  source.envMapIntensity = 0.7;
  source.vertexColors = true;
  source.flatShading = true;
  source.wireframe = true;
  source.polygonOffset = true;
  source.polygonOffsetFactor = 2;
  source.polygonOffsetUnits = 3;
  source.name = 'character-source';
  source.userData = { authored: true };

  const converted = rim.convertStandardMaterial(source);
  assert.equal(converted.isMeshStandardNodeMaterial, true);
  assert.equal(rim.convertStandardMaterial(source), converted);
  assert.equal(rim.convertStandardMaterial(converted), converted);
  assert.equal(converted.name, source.name);
  assert.equal(converted.color.getHex(), source.color.getHex());
  assert.equal(converted.emissive.getHex(), source.emissive.getHex());
  assert.equal(converted.emissiveIntensity, source.emissiveIntensity);
  assert.equal(converted.map, map);
  assert.equal(converted.normalMap, map);
  assert.deepEqual(converted.normalScale.toArray(), [0.55, 0.8]);
  assert.equal(converted.roughnessMap, map);
  assert.equal(converted.metalnessMap, map);
  assert.equal(converted.emissiveMap, map);
  assert.equal(converted.aoMap, map);
  assert.equal(converted.aoMapIntensity, 0.65);
  assert.equal(converted.alphaMap, map);
  assert.equal(converted.envMap, map);
  assert.equal(converted.envMapIntensity, 0.7);
  assert.equal(converted.roughness, source.roughness);
  assert.equal(converted.metalness, source.metalness);
  assert.equal(converted.transparent, true);
  assert.equal(converted.opacity, 0.72);
  assert.equal(converted.alphaTest, 0.15);
  assert.equal(converted.depthWrite, false);
  assert.equal(converted.depthTest, true);
  assert.equal(converted.side, THREE.DoubleSide);
  assert.equal(converted.blending, THREE.AdditiveBlending);
  assert.equal(converted.vertexColors, true);
  assert.equal(converted.flatShading, true);
  assert.equal(converted.wireframe, true);
  assert.equal(converted.polygonOffset, true);
  assert.equal(converted.polygonOffsetFactor, 2);
  assert.equal(converted.polygonOffsetUnits, 3);
  assert.deepEqual(converted.userData, source.userData);
});

test('GLTF physical materials retain their physical node lighting model and extension fields', () => {
  const map = new THREE.DataTexture(new Uint8Array([180, 210, 255, 255]), 1, 1);
  map.needsUpdate = true;
  const source = new THREE.MeshPhysicalMaterial({
    color: 0x789abc,
    roughness: 0.33,
    metalness: 0.17,
    clearcoat: 0.62,
    clearcoatRoughness: 0.21,
    sheen: 0.45,
    sheenColor: 0xc080ff,
    sheenRoughness: 0.37,
    iridescence: 0.52,
    iridescenceIOR: 1.42,
    iridescenceThicknessRange: [120, 430],
    specularIntensity: 0.73,
    specularColor: 0xe8f4ff,
    ior: 1.38,
    transmission: 0.24,
    thickness: 0.16,
    attenuationDistance: 2.8,
    attenuationColor: 0xaaddff,
    dispersion: 0.08,
    anisotropy: 0.31,
    anisotropyRotation: 0.27,
  });
  source.clearcoatMap = map;
  source.clearcoatRoughnessMap = map;
  source.clearcoatNormalMap = map;
  source.clearcoatNormalScale.set(0.7, 0.8);
  source.sheenColorMap = map;
  source.sheenRoughnessMap = map;
  source.iridescenceMap = map;
  source.iridescenceThicknessMap = map;
  source.specularIntensityMap = map;
  source.specularColorMap = map;
  source.transmissionMap = map;
  source.thicknessMap = map;
  source.anisotropyMap = map;

  const converted = rim.convertStandardMaterial(source);
  assert.equal(converted.isMeshPhysicalNodeMaterial, true);
  assert.equal(converted.isMeshStandardNodeMaterial, true);
  assert.equal(converted.clearcoat, source.clearcoat);
  assert.equal(converted.clearcoatRoughness, source.clearcoatRoughness);
  assert.equal(converted.clearcoatMap, map);
  assert.equal(converted.clearcoatRoughnessMap, map);
  assert.equal(converted.clearcoatNormalMap, map);
  assert.deepEqual(converted.clearcoatNormalScale.toArray(), [0.7, 0.8]);
  assert.equal(converted.sheen, source.sheen);
  assert.equal(converted.sheenColor.getHex(), source.sheenColor.getHex());
  assert.equal(converted.sheenColorMap, map);
  assert.equal(converted.sheenRoughness, source.sheenRoughness);
  assert.equal(converted.sheenRoughnessMap, map);
  assert.equal(converted.iridescence, source.iridescence);
  assert.equal(converted.iridescenceIOR, source.iridescenceIOR);
  assert.deepEqual(converted.iridescenceThicknessRange, source.iridescenceThicknessRange);
  assert.notEqual(converted.iridescenceThicknessRange, source.iridescenceThicknessRange);
  assert.equal(converted.iridescenceMap, map);
  assert.equal(converted.iridescenceThicknessMap, map);
  assert.equal(converted.specularIntensity, source.specularIntensity);
  assert.equal(converted.specularColor.getHex(), source.specularColor.getHex());
  assert.equal(converted.specularIntensityMap, map);
  assert.equal(converted.specularColorMap, map);
  assert.equal(converted.ior, source.ior);
  assert.equal(converted.transmission, source.transmission);
  assert.equal(converted.transmissionMap, map);
  assert.equal(converted.thickness, source.thickness);
  assert.equal(converted.thicknessMap, map);
  assert.equal(converted.attenuationDistance, source.attenuationDistance);
  assert.equal(converted.attenuationColor.getHex(), source.attenuationColor.getHex());
  assert.equal(converted.dispersion, source.dispersion);
  assert.equal(converted.anisotropy, source.anisotropy);
  assert.equal(converted.anisotropyRotation, source.anisotropyRotation);
  assert.equal(converted.anisotropyMap, map);
  assert.deepEqual(converted.defines, source.defines);
  assert.notEqual(converted.defines, source.defines);

  const rimmed = rim.createRimLightMaterial(source);
  assert.equal(rimmed, converted);
  assert.equal(rimmed.isMeshPhysicalNodeMaterial, true);
  assert.ok(rim.getRimLightController(source)?.nodes.contribution.isNode);
});

test('rim graph is idempotent, additive, and exposes released defaults', () => {
  const source = new THREE.MeshStandardMaterial({
    emissive: 0x102030,
    emissiveIntensity: 0.4,
  });
  const material = rim.createRimLightMaterial(source);
  const emissiveNode = material.emissiveNode;
  const controller = rim.getRimLightController(source);

  assert.equal(material.isMeshStandardNodeMaterial, true);
  assert.ok(emissiveNode?.isNode);
  assert.ok(controller.nodes.viewDirection.isNode);
  assert.ok(controller.nodes.contribution.isNode);
  assert.equal(controller.uniforms.color.value.getHex(), 0xaaccff);
  assert.equal(controller.uniforms.power.value, 2.4);
  assert.equal(controller.uniforms.strength.value, 0.35);

  assert.equal(rim.createRimLightMaterial(source, { strength: 0.2 }), material);
  assert.equal(material.emissiveNode, emissiveNode);
  assert.equal(controller.uniforms.strength.value, 0.2);
});

test('damage flash composes with rim and supports per-root uniform state', () => {
  const source = new THREE.MeshStandardMaterial({
    emissive: 0x221100,
    emissiveIntensity: 0.3,
  });
  const material = rim.createRimLightMaterial(source);
  const rimController = rim.getRimLightController(material);
  assert.equal(damage.createDamageFlashMaterial(material), material);

  const template = damage.getDamageFlashMaterialController(material);
  const graphNodes = new Set();
  material.emissiveNode.traverse((node) => graphNodes.add(node.uuid));
  assert.ok(graphNodes.has(rimController.nodes.contribution.uuid));
  assert.ok(graphNodes.has(template.nodes.delta.uuid));
  assert.equal(template.uniforms.color.value.getHex(), 0xffffff);
  assert.equal(template.uniforms.intensity.value, 1.6);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  const root = new THREE.Group();
  root.add(mesh);
  const controller = damage.createDamageFlashController(root);
  assert.equal(controller.materials.length, 1);
  assert.equal(controller.objects.length, 1);
  assert.equal(controller.setFlashing(true), controller);
  assert.equal(controller.values.amount, 1);
  assert.equal(controller.amount.value, 1);
  controller.setAmount(0.25).setIntensity(1.2).setColor(0xffccaa);
  assert.equal(controller.values.amount, 0.25);
  assert.equal(controller.intensity.value, 1.2);
  assert.equal(controller.color.value.getHex(), 0xffccaa);
  assert.equal(damage.createDamageFlashController(root), controller);
});

test('damage flash skips unsupported submaterials and isolates shared-material root state', () => {
  const shared = new THREE.MeshStandardMaterial({ color: 0x6688aa });
  const basic = new THREE.MeshBasicMaterial({ color: 0x22aa55 });
  const firstMesh = new THREE.Mesh(new THREE.BoxGeometry(), [shared, basic]);
  const secondMesh = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  const firstRoot = new THREE.Group();
  const secondRoot = new THREE.Group();
  firstRoot.add(firstMesh);
  secondRoot.add(secondMesh);

  const first = damage.createDamageFlashController(firstRoot, {
    color: 0xffffff,
    intensity: 1.6,
    amount: 0.25,
  });
  const second = damage.createDamageFlashController(secondRoot, {
    color: 0xff2200,
    intensity: 0.7,
    amount: 0.8,
  });

  assert.equal(firstMesh.material[1], basic);
  assert.equal(first.materials.length, 1);
  assert.equal(firstMesh.material[0], secondMesh.material);
  assert.equal(first.color.value.getHex(), 0xffffff);
  assert.equal(second.color.value.getHex(), 0xff2200);
  assert.equal(first.intensity.value, 1.6);
  assert.equal(second.intensity.value, 0.7);
  assert.equal(first.amount.value, 0.25);
  assert.equal(second.amount.value, 0.8);

  second.setColor(0x33ff88).setIntensity(1.1).setAmount(0.4);
  assert.equal(first.color.value.getHex(), 0xffffff);
  assert.equal(first.intensity.value, 1.6);
  assert.equal(first.amount.value, 0.25);
  assert.equal(second.color.value.getHex(), 0x33ff88);
});

test('damage flash preserves authored exclusions and updates bare materials in mixed targets', () => {
  const body = new THREE.MeshStandardMaterial({ name: 'body' });
  const ruby = new THREE.MeshStandardMaterial({ name: 'ruby_core' });
  const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(), body);
  bodyMesh.name = 'nemesis_body';
  const rubyMesh = new THREE.Mesh(new THREE.BoxGeometry(), ruby);
  rubyMesh.name = 'nemesis_ruby';
  const root = new THREE.Group();
  root.add(bodyMesh, rubyMesh);
  const standalone = new THREE.MeshStandardMaterial({ name: 'standalone' });
  const targets = [root, standalone];

  const controller = damage.createDamageFlashController(targets, {
    amount: 0.2,
    filterObject: (object) => object.name !== 'nemesis_ruby',
    filterMaterial: (material) => material.name !== 'ruby_core',
  });

  assert.equal(bodyMesh.material.isNodeMaterial, true);
  assert.equal(rubyMesh.material, ruby);
  assert.equal(targets[1].isNodeMaterial, true);
  assert.equal(controller.objects.length, 1);
  assert.equal(controller.materials.length, 2);
  controller.setAmount(0.75).setIntensity(1.1).setColor(0x55ffaa);
  const standaloneTemplate = damage.getDamageFlashMaterialController(targets[1]);
  assert.equal(standaloneTemplate.uniforms.amount.value, 0.75);
  assert.equal(standaloneTemplate.uniforms.intensity.value, 1.1);
  assert.equal(standaloneTemplate.uniforms.color.value.getHex(), 0x55ffaa);
  assert.throws(
    () => damage.createDamageFlashController(targets, { filterObject: () => true }),
    /filters cannot change/,
  );

  // Rim conversion can make included and excluded meshes share one node
  // material. Filtered draws must keep the template's zero-flash fallback;
  // only the included object's onObjectUpdate state may become non-zero.
  const sharedNode = rim.createRimLightMaterial(new THREE.MeshStandardMaterial());
  const included = new THREE.Mesh(new THREE.BoxGeometry(), sharedNode);
  included.name = 'included-body';
  const excluded = new THREE.Mesh(new THREE.BoxGeometry(), sharedNode);
  excluded.name = 'excluded-core';
  const sharedRoot = new THREE.Group();
  sharedRoot.add(included, excluded);
  const filtered = damage.createDamageFlashController(sharedRoot, {
    amount: 0.4,
    filterObject: (object) => object.name !== 'excluded-core',
  });
  filtered.setAmount(1);
  const sharedTemplate = damage.getDamageFlashMaterialController(sharedNode);
  assert.equal(filtered.amount.value, 1);
  assert.equal(sharedTemplate.uniforms.amount.value, 0);
});

test('creature controller shares templates while retaining per-root clock state', () => {
  const source = new THREE.MeshStandardMaterial({ color: 0xabcdef });
  const first = new THREE.Mesh(new THREE.BoxGeometry(), source);
  const second = new THREE.Mesh(new THREE.BoxGeometry(), source);
  const root = new THREE.Group();
  root.add(first, second);

  const controller = creature.createCreatureAnimationController(root, {
    kind: 'crawl',
    time: 1.5,
    amplitude: 0.8,
  });
  assert.equal(controller.kind, 'crawl');
  assert.equal(controller.materials.length, 1);
  assert.equal(controller.objects.length, 2);
  assert.equal(first.material, second.material);
  assert.equal(first.material.isMeshStandardNodeMaterial, true);
  assert.ok(first.material.positionNode?.isNode);
  assert.equal(controller.time.value, 1.5);
  assert.equal(controller.amplitude.value, 0.8);

  assert.equal(controller.updateTime(3.25), controller);
  assert.equal(controller.setAmplitude(0), controller);
  assert.equal(controller.values.time, 3.25);
  assert.equal(controller.values.amplitude, 0);
  assert.equal(controller.time.value, 3.25);
  assert.equal(controller.amplitude.value, 0);
  assert.equal(creature.createCreatureAnimationController(root, { kind: 'crawl' }), controller);
});

test('creature controllers isolate shared-material clocks and reject non-static geometry atomically', () => {
  const shared = new THREE.MeshStandardMaterial({ color: 0xbba066 });
  const firstMesh = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  const secondMesh = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  const first = creature.createCreatureAnimationController(firstMesh, {
    kind: 'hover',
    time: 1.2,
    amplitude: 0.4,
  });
  const second = creature.createCreatureAnimationController(secondMesh, {
    kind: 'hover',
    time: 4.8,
    amplitude: 0.9,
  });
  assert.equal(firstMesh.material, secondMesh.material);
  assert.equal(first.time.value, 1.2);
  assert.equal(second.time.value, 4.8);
  assert.equal(first.amplitude.value, 0.4);
  assert.equal(second.amplitude.value, 0.9);
  second.updateTime(7).setAmplitude(0.1);
  assert.equal(first.time.value, 1.2);
  assert.equal(first.amplitude.value, 0.4);

  const untouchedSource = new THREE.MeshStandardMaterial();
  const ordinary = new THREE.Mesh(new THREE.BoxGeometry(), untouchedSource);
  const instanced = new THREE.InstancedMesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial(),
    1,
  );
  const unsupportedRoot = new THREE.Group();
  unsupportedRoot.add(ordinary, instanced);
  assert.throws(
    () => creature.createCreatureAnimationController(unsupportedRoot, { kind: 'crawl' }),
    /ordinary static Mesh/,
  );
  assert.equal(ordinary.material, untouchedSource);
  assert.equal(ordinary.material.isNodeMaterial, undefined);

  const morphGeometry = new THREE.BoxGeometry();
  morphGeometry.morphAttributes.position = [morphGeometry.attributes.position.clone()];
  const morphMesh = new THREE.Mesh(morphGeometry, new THREE.MeshStandardMaterial());
  assert.throws(
    () => creature.createCreatureAnimationController(morphMesh, { kind: 'crawl' }),
    /without morph targets/,
  );
});

test('creature mixed targets update bare-material template defaults', () => {
  const rootMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const standalone = new THREE.MeshStandardMaterial();
  const targets = [rootMesh, standalone];
  const controller = creature.createCreatureAnimationController(targets, {
    kind: 'hover',
    time: 1,
    amplitude: 0.5,
  });
  controller.updateTime(4.5).setAmplitude(0.25);
  const standaloneTemplate = creature.getCreatureAnimationMaterialController(targets[1]);
  assert.equal(standaloneTemplate.uniforms.time.value, 4.5);
  assert.equal(standaloneTemplate.uniforms.amplitude.value, 0.25);
  assert.equal(controller.time.value, 4.5);
  assert.equal(controller.amplitude.value, 0.25);

  const shared = new THREE.MeshStandardMaterial();
  const controlled = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  const external = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  const rootOnly = creature.createCreatureAnimationController(controlled, {
    kind: 'crawl',
    time: 2,
    amplitude: 0.7,
  });
  external.material = controlled.material;
  rootOnly.updateTime(8).setAmplitude(0.1);
  const sharedTemplate = creature.getCreatureAnimationMaterialController(controlled.material);
  assert.equal(rootOnly.time.value, 8);
  assert.equal(rootOnly.amplitude.value, 0.1);
  assert.equal(sharedTemplate.uniforms.time.value, 0);
  assert.equal(sharedTemplate.uniforms.amplitude.value, 1);
});

test('all four released deformation families build stable r185 node graphs', () => {
  for (const kind of creature.CREATURE_ANIMATION_KINDS) {
    const source = new THREE.MeshStandardMaterial();
    const material = creature.createCreatureAnimationMaterial(source, { kind });
    const template = creature.getCreatureAnimationMaterialController(source);
    assert.equal(template.kind, kind);
    assert.ok(material.positionNode?.isNode);
    assert.ok(template.uniforms.time.isUniformNode);
    assert.ok(template.uniforms.amplitude.isUniformNode);
    assert.ok(template.nodes.displacement.isNode);
    assert.equal(creature.createCreatureAnimationMaterial(source, { kind }), material);
  }

  assert.throws(
    () => creature.createCreatureAnimationMaterial(new THREE.MeshStandardMaterial(), { kind: 'unknown' }),
    /Unknown creature animation kind/,
  );
});

test('source contract contains no WebGL shader hooks and retains exact legacy math', async () => {
  const sources = Object.fromEntries(await Promise.all(MODULE_NAMES.map(async (name) => [
    name,
    await fs.readFile(path.join(MATERIAL_DIR, name), 'utf8'),
  ])));
  const all = Object.values(sources).join('\n');

  assert.doesNotMatch(all, /onBeforeCompile|ShaderMaterial|vertexShader|fragmentShader/);
  assert.match(sources['rimLightMaterial.js'], /normalize\(positionView\.negate\(\)\)/);
  assert.match(sources['rimLightMaterial.js'], /dot\(normalViewGeometry, viewDirectionNode\)/);
  assert.match(sources['rimLightMaterial.js'], /power:\s*2\.4/);
  assert.match(sources['rimLightMaterial.js'], /strength:\s*0\.35/);

  const animation = sources['creatureAnimationMaterial.js'];
  assert.match(animation, /float\(1\)\.sub\(\s*smoothstep\(float\(-0\.5\), float\(0\.5\), sourcePosition\.y\)/s);
  assert.doesNotMatch(animation, /smoothstep\(float\(0\.5\), float\(-0\.5\)/);
  assert.match(animation, /timeNode\.mul\(18\).*sourcePosition\.x\.mul\(6\)/s);
  assert.match(animation, /xWave\.mul\(0\.10\)/);
  assert.match(animation, /zWave\.mul\(0\.06\)/);
  assert.match(animation, /timeNode\.mul\(22\)/);
  assert.match(animation, /mul\(0\.45\)/);
  assert.match(animation, /timeNode\.mul\(80\)/);
  assert.match(animation, /mul\(0\.10\)/);
  assert.match(animation, /timeNode\.mul\(6\).*sourcePosition\.x\.mul\(4\)/s);
  assert.match(animation, /pulse\.mul\(0\.08\)/);
  assert.match(animation, /lift\.mul\(0\.04\)/);

  for (const source of Object.values(sources)) {
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier === 'three/webgpu'
          || specifier === 'three/tsl'
          || specifier === './rimLightMaterial.js',
        `unexpected material dependency: ${specifier}`,
      );
    }
  }
});
