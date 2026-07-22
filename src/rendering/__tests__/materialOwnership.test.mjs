import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../..');
const THREE = await import(pathToFileURL(path.join(ROOT, 'vendor/three/build/three.module.js')).href);
const ownership = await import('../materials/materialOwnership.js');

function mesh(material) {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
}

test('one root-local clone replaces every occurrence of a shared source material', () => {
  const shared = new THREE.MeshStandardMaterial({ color: 0x336699 });
  const secondary = new THREE.MeshBasicMaterial({ color: 0xff8800 });
  let sharedCloneCalls = 0;
  const originalClone = shared.clone.bind(shared);
  shared.clone = () => {
    sharedCloneCalls += 1;
    return originalClone();
  };

  const root = new THREE.Group();
  const first = mesh(shared);
  const second = mesh([shared, secondary, shared]);
  root.add(first, second);

  const result = ownership.ownRootMaterials(root);

  assert.equal(result.meshCount, 2);
  assert.equal(result.materialSlotCount, 4);
  assert.equal(result.clonedCount, 2);
  assert.equal(result.promotedCount, 0);
  assert.equal(sharedCloneCalls, 1);
  assert.notEqual(first.material, shared);
  assert.equal(first.material, second.material[0]);
  assert.equal(second.material[0], second.material[2]);
  assert.notEqual(second.material[1], secondary);
  assert.equal(result.sourceToOwned.get(shared), first.material);
});

test('separate roots never share mutable owned material instances', () => {
  const cachedSource = new THREE.MeshStandardMaterial({ emissive: 0x112233 });
  const rootA = mesh(cachedSource);
  const rootB = mesh(cachedSource);

  ownership.ownRootMaterials(rootA);
  ownership.ownRootMaterials(rootB);

  assert.notEqual(rootA.material, cachedSource);
  assert.notEqual(rootB.material, cachedSource);
  assert.notEqual(rootA.material, rootB.material);

  rootA.material.emissive.set(0xff0000);
  assert.equal(rootB.material.emissive.getHex(), 0x112233);
  assert.equal(cachedSource.emissive.getHex(), 0x112233);
});

test('promotion preserves compatible surface fields and complete Material render state', () => {
  const texture = new THREE.DataTexture(new Uint8Array([255, 128, 64, 255]), 1, 1);
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -2);
  const source = new THREE.MeshPhongMaterial({
    color: 0x345678,
    emissive: 0x123456,
    emissiveIntensity: 0,
    map: texture,
    transparent: true,
    opacity: 0.42,
    alphaTest: 0.27,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
  });
  source.name = 'authored-phong';
  source.lightMap = texture;
  source.lightMapIntensity = 0.31;
  source.aoMap = texture;
  source.aoMapIntensity = 0.52;
  source.emissiveMap = texture;
  source.bumpMap = texture;
  source.bumpScale = 0.28;
  source.normalMap = texture;
  source.normalMapType = THREE.ObjectSpaceNormalMap;
  source.normalScale.set(0.6, 0.7);
  source.displacementMap = texture;
  source.displacementScale = 0.18;
  source.displacementBias = -0.03;
  source.alphaMap = texture;
  source.envMap = texture;
  source.envMapIntensity = 0.77;
  source.envMapRotation.set(0.1, 0.2, 0.3);
  source.wireframe = true;
  source.wireframeLinewidth = 2;
  source.flatShading = true;
  source.fog = false;
  source.vertexColors = true;
  source.blendSrc = THREE.OneFactor;
  source.blendDst = THREE.OneMinusSrcAlphaFactor;
  source.blendEquation = THREE.ReverseSubtractEquation;
  source.blendSrcAlpha = THREE.SrcAlphaFactor;
  source.blendDstAlpha = THREE.OneMinusDstAlphaFactor;
  source.blendEquationAlpha = THREE.AddEquation;
  source.blendColor.set(0xabcdef);
  source.blendAlpha = 0.63;
  source.depthFunc = THREE.GreaterDepth;
  source.stencilWrite = true;
  source.stencilWriteMask = 0x0f;
  source.stencilFunc = THREE.NotEqualStencilFunc;
  source.stencilRef = 3;
  source.stencilFuncMask = 0xf0;
  source.stencilFail = THREE.ReplaceStencilOp;
  source.stencilZFail = THREE.IncrementStencilOp;
  source.stencilZPass = THREE.DecrementStencilOp;
  source.clippingPlanes = [plane];
  source.clipIntersection = true;
  source.clipShadows = true;
  source.shadowSide = THREE.BackSide;
  source.colorWrite = false;
  source.precision = 'mediump';
  source.polygonOffset = true;
  source.polygonOffsetFactor = 2;
  source.polygonOffsetUnits = 4;
  source.dithering = true;
  source.alphaHash = true;
  source.alphaToCoverage = true;
  source.premultipliedAlpha = true;
  source.forceSinglePass = true;
  source.allowOverride = false;
  source.visible = false;
  source.toneMapped = false;
  source.userData = { authored: true, nested: { family: 'bug' } };

  const material = ownership.promoteLegacyMaterialToStandard(source, {
    constructors: THREE,
    standardParameters: {
      roughness: 0.65,
      metalness: 0.05,
    },
  });

  assert.equal(material.isMeshStandardMaterial, true);
  assert.equal(material.isMeshPhongMaterial, undefined);
  assert.equal(material.name, source.name);
  assert.equal(material.color.getHex(), source.color.getHex());
  assert.equal(material.emissive.getHex(), source.emissive.getHex());
  assert.equal(material.emissiveIntensity, 0);
  for (const field of [
    'map', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap',
    'displacementMap', 'alphaMap', 'envMap',
  ]) assert.equal(material[field], texture, field);
  assert.equal(material.lightMapIntensity, 0.31);
  assert.equal(material.aoMapIntensity, 0.52);
  assert.equal(material.bumpScale, 0.28);
  assert.equal(material.normalMapType, THREE.ObjectSpaceNormalMap);
  assert.deepEqual(material.normalScale.toArray(), [0.6, 0.7]);
  assert.equal(material.displacementScale, 0.18);
  assert.equal(material.displacementBias, -0.03);
  assert.equal(material.envMapIntensity, 0.77);
  assert.deepEqual(material.envMapRotation.toArray().slice(0, 3), [0.1, 0.2, 0.3]);
  assert.equal(material.roughness, 0.65);
  assert.equal(material.metalness, 0.05);
  assert.equal(material.wireframe, true);
  assert.equal(material.wireframeLinewidth, 2);
  assert.equal(material.flatShading, true);
  assert.equal(material.fog, false);
  assert.equal(material.vertexColors, true);
  assert.equal(material.transparent, true);
  assert.equal(material.opacity, 0.42);
  assert.equal(material.alphaTest, 0.27);
  assert.equal(material.side, THREE.DoubleSide);
  assert.equal(material.blending, THREE.CustomBlending);
  assert.equal(material.blendSrc, THREE.OneFactor);
  assert.equal(material.blendDst, THREE.OneMinusSrcAlphaFactor);
  assert.equal(material.blendEquation, THREE.ReverseSubtractEquation);
  assert.equal(material.blendSrcAlpha, THREE.SrcAlphaFactor);
  assert.equal(material.blendDstAlpha, THREE.OneMinusDstAlphaFactor);
  assert.equal(material.blendEquationAlpha, THREE.AddEquation);
  assert.equal(material.blendColor.getHex(), 0xabcdef);
  assert.equal(material.blendAlpha, 0.63);
  assert.equal(material.depthFunc, THREE.GreaterDepth);
  assert.equal(material.depthTest, false);
  assert.equal(material.depthWrite, false);
  assert.equal(material.stencilWrite, true);
  assert.equal(material.stencilWriteMask, 0x0f);
  assert.equal(material.stencilFunc, THREE.NotEqualStencilFunc);
  assert.equal(material.stencilRef, 3);
  assert.equal(material.stencilFuncMask, 0xf0);
  assert.equal(material.stencilFail, THREE.ReplaceStencilOp);
  assert.equal(material.stencilZFail, THREE.IncrementStencilOp);
  assert.equal(material.stencilZPass, THREE.DecrementStencilOp);
  assert.notEqual(material.clippingPlanes, source.clippingPlanes);
  assert.notEqual(material.clippingPlanes[0], plane);
  assert.equal(material.clippingPlanes[0].constant, -2);
  assert.equal(material.clipIntersection, true);
  assert.equal(material.clipShadows, true);
  assert.equal(material.shadowSide, THREE.BackSide);
  assert.equal(material.colorWrite, false);
  assert.equal(material.precision, 'mediump');
  assert.equal(material.polygonOffset, true);
  assert.equal(material.polygonOffsetFactor, 2);
  assert.equal(material.polygonOffsetUnits, 4);
  assert.equal(material.dithering, true);
  assert.equal(material.alphaHash, true);
  assert.equal(material.alphaToCoverage, true);
  assert.equal(material.premultipliedAlpha, true);
  assert.equal(material.forceSinglePass, true);
  assert.equal(material.allowOverride, false);
  assert.equal(material.visible, false);
  assert.equal(material.toneMapped, false);
  assert.deepEqual(material.userData, source.userData);
  assert.notEqual(material.userData, source.userData);
  assert.notEqual(material.userData.nested, source.userData.nested);
});

test('Basic and Lambert materials promote while Standard, Physical and Node flags do not', () => {
  const basic = new THREE.MeshBasicMaterial({ color: 0xabcdef });
  const lambert = new THREE.MeshLambertMaterial({ color: 0xfedcba });
  const standard = new THREE.MeshStandardMaterial();
  const physical = new THREE.MeshPhysicalMaterial({ clearcoat: 0.75 });
  const nodeLike = new THREE.MeshBasicMaterial();
  nodeLike.isNodeMaterial = true;

  assert.equal(ownership.isLegacyLitMaterial(basic), true);
  assert.equal(ownership.isLegacyLitMaterial(lambert), true);
  assert.equal(ownership.isLegacyLitMaterial(standard), false);
  assert.equal(ownership.isLegacyLitMaterial(physical), false);
  assert.equal(ownership.isLegacyLitMaterial(nodeLike), false);

  const root = new THREE.Group();
  const basicMesh = mesh(basic);
  const lambertMesh = mesh(lambert);
  const standardMesh = mesh(standard);
  const physicalMesh = mesh(physical);
  root.add(basicMesh, lambertMesh, standardMesh, physicalMesh);

  const result = ownership.ownRootMaterials(root, {
    promoteLegacy: true,
    constructors: THREE,
    standardParameters: { roughness: 0.82, metalness: 0.04 },
  });

  assert.equal(result.clonedCount, 4);
  assert.equal(result.promotedCount, 2);
  assert.equal(basicMesh.material.isMeshStandardMaterial, true);
  assert.equal(lambertMesh.material.isMeshStandardMaterial, true);
  assert.equal(standardMesh.material.isMeshStandardMaterial, true);
  assert.notEqual(standardMesh.material, standard);
  assert.equal(physicalMesh.material.isMeshPhysicalMaterial, true);
  assert.equal(physicalMesh.material.clearcoat, 0.75);
  assert.notEqual(physicalMesh.material, physical);
});

test('material arrays preserve null slots and repeated references', () => {
  const source = new THREE.MeshStandardMaterial();
  const object = mesh([null, source, null, source]);
  const result = ownership.ownRootMaterials(object);

  assert.equal(result.materialSlotCount, 2);
  assert.equal(result.clonedCount, 1);
  assert.deepEqual(object.material.slice(0, 1), [null]);
  assert.equal(object.material[1], object.material[3]);
  assert.equal(object.material[2], null);
});

test('failed cloning is atomic and leaves all mesh bindings unchanged', () => {
  const good = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  const broken = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  let temporaryClone = null;
  let temporaryDisposals = 0;
  good.clone = () => {
    temporaryClone = new THREE.MeshStandardMaterial().copy(good);
    temporaryClone.addEventListener('dispose', () => { temporaryDisposals += 1; });
    return temporaryClone;
  };
  broken.clone = () => {
    throw new Error('intentional clone failure');
  };

  const first = mesh(good);
  const second = mesh([good, broken]);
  const root = new THREE.Group();
  root.add(first, second);

  assert.throws(
    () => ownership.ownRootMaterials(root),
    /intentional clone failure/,
  );
  assert.equal(first.material, good);
  assert.equal(second.material[0], good);
  assert.equal(second.material[1], broken);
  assert.ok(temporaryClone);
  assert.equal(temporaryDisposals, 1);
});

test('invalid roots, promotion injection and same-instance clones fail loudly', () => {
  assert.throws(() => ownership.ownRootMaterials(null), /Object3D root/);
  assert.throws(
    () => ownership.ownRootMaterials(new THREE.Group(), { promoteLegacy: true }),
    /injected.*MeshStandardMaterial/i,
  );

  const source = new THREE.MeshStandardMaterial();
  source.clone = () => source;
  assert.throws(
    () => ownership.ownRootMaterials(mesh(source)),
    /distinct material instance/,
  );
});
