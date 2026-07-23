#!/usr/bin/env node
/**
 * Machine-readable audit for every Forest v2 enemy source GLB.
 *
 * This intentionally parses GLB JSON/accessor metadata directly so the audit
 * can run in CI without a browser, native glTF SDK, or Blender install.
 *
 * Usage:
 *   node tools/inspect-forest-enemies.mjs
 *   node tools/inspect-forest-enemies.mjs --json docs/enemy-animation/FOREST_SOURCE_AUDIT.json
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECIES = Object.freeze([
  'Ant', 'Beetle', 'Ladybug', 'Grasshopper', 'Cockroach',
  'Mantis', 'Wasp', 'Bee', 'Butterfly', 'Caterpillar', 'Spider',
]);

const COMPONENT_WORDS = Object.freeze({
  limbs: /(?:leg|arm|claw|foreleg|hindleg|foot|feet)/i,
  wings: /(?:wing|elytra)/i,
  antennae: /(?:antenna|antler|feel(?:er)?)/i,
  shell: /(?:shell|carapace|elytra)/i,
  head: /(?:head|mandible|jaw|eye)/i,
  bodySections: /(?:body|thorax|abdomen|tail|segment|chest)/i,
});

const PROJECT_ATTRIBUTION = Object.freeze({
  Wasp: {
    author: 'Quaternius',
    license: 'CC0',
    source: 'Quaternius Ultimate Monsters bundle',
    recordedIn: ['README.md:113', 'src/ui.js:8130'],
  },
  Spider: {
    author: 'Quaternius',
    license: 'CC0',
    source: 'Quaternius Ultimate Monsters bundle',
    recordedIn: ['README.md:113', 'src/ui.js:8130'],
  },
  default: {
    author: 'Poly by Google',
    license: 'CC-BY',
    source: 'Poly Pizza',
    recordedIn: ['README.md:114', 'src/ui.js:8131'],
  },
});

function readGlb(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error(`Not a GLB: ${filePath}`);
  }
  const declaredLength = data.readUInt32LE(8);
  if (declaredLength !== data.length) {
    throw new Error(`GLB length mismatch: header=${declaredLength}, file=${data.length}`);
  }
  let offset = 12;
  while (offset + 8 <= data.length) {
    const chunkLength = data.readUInt32LE(offset);
    const chunkType = data.toString('ascii', offset + 4, offset + 8);
    if (chunkType === 'JSON') {
      const raw = data.toString('utf8', offset + 8, offset + 8 + chunkLength);
      return JSON.parse(raw.replace(/\0+$/, '').trim());
    }
    offset += 8 + chunkLength;
  }
  throw new Error(`No JSON chunk in ${filePath}`);
}

function primitiveTriangleCount(json, primitive) {
  const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
  const count = accessorIndex == null ? 0 : (json.accessors?.[accessorIndex]?.count ?? 0);
  const mode = primitive.mode ?? 4;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function nodeLabel(node, index) {
  return node?.name || `node_${index}`;
}

function hierarchy(json) {
  const nodes = json.nodes ?? [];
  const childIds = new Set();
  for (const node of nodes) for (const child of node.children ?? []) childIds.add(child);
  const roots = [];
  const walk = (index, depth) => {
    const node = nodes[index] ?? {};
    const tags = [];
    if (node.mesh != null) tags.push(`mesh:${node.mesh}`);
    if (node.skin != null) tags.push(`skin:${node.skin}`);
    if (node.camera != null) tags.push(`camera:${node.camera}`);
    const line = `${'  '.repeat(depth)}${nodeLabel(node, index)}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
    const out = [line];
    for (const child of node.children ?? []) out.push(...walk(child, depth + 1));
    return out;
  };
  for (let i = 0; i < nodes.length; i++) if (!childIds.has(i)) roots.push(...walk(i, 0));
  return roots;
}

function animationDuration(json, animation) {
  let duration = 0;
  for (const sampler of animation.samplers ?? []) {
    const accessor = json.accessors?.[sampler.input];
    if (!accessor) continue;
    const min = accessor.min?.[0] ?? 0;
    const max = accessor.max?.[0] ?? min;
    duration = Math.max(duration, max - min);
  }
  return duration;
}

function namedComponentReport(json) {
  const nodeNames = (json.nodes ?? []).map((node, index) => nodeLabel(node, index));
  const meshNames = (json.meshes ?? []).map((mesh, index) => mesh.name || `mesh_${index}`);
  const all = [...nodeNames, ...meshNames];
  const result = {};
  for (const [key, pattern] of Object.entries(COMPONENT_WORDS)) {
    result[key] = all.filter((name) => pattern.test(name));
  }
  return result;
}

function inspect(species) {
  const relativePath = `assets/breakroom/${species}.glb`;
  const filePath = path.join(ROOT, relativePath);
  const json = readGlb(filePath);
  const meshes = json.meshes ?? [];
  const nodes = json.nodes ?? [];
  let triangles = 0;
  let primitiveCount = 0;
  const usedMaterials = new Set();
  let morphTargetCount = 0;
  const morphMeshes = [];
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
    const mesh = meshes[meshIndex];
    let meshTargets = 0;
    for (const primitive of mesh.primitives ?? []) {
      triangles += primitiveTriangleCount(json, primitive);
      primitiveCount++;
      if (primitive.material != null) usedMaterials.add(primitive.material);
      const targetCount = primitive.targets?.length ?? 0;
      meshTargets = Math.max(meshTargets, targetCount);
      morphTargetCount += targetCount;
    }
    if (meshTargets > 0) {
      morphMeshes.push({
        mesh: mesh.name || `mesh_${meshIndex}`,
        targetCount: meshTargets,
        names: mesh.extras?.targetNames ?? [],
      });
    }
  }

  const meshNodes = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.mesh != null);
  const skins = json.skins ?? [];
  const boneIds = new Set();
  for (const skin of skins) for (const joint of skin.joints ?? []) boneIds.add(joint);
  const components = namedComponentReport(json);
  const animations = (json.animations ?? []).map((animation, index) => ({
    name: animation.name || `animation_${index}`,
    durationSeconds: Number(animationDuration(json, animation).toFixed(6)),
    channels: animation.channels?.length ?? 0,
    targetPaths: [...new Set((animation.channels ?? []).map((channel) => channel.target?.path).filter(Boolean))],
  }));
  const hasUsableClip = animations.some((animation) => animation.durationSeconds > 0 && animation.channels > 0);
  const hasSeparateRigidComponents = skins.length === 0 && meshNodes.length > 1;
  const fusedStaticMesh = !hasUsableClip
    && skins.length === 0
    && morphTargetCount === 0
    && meshNodes.length === 1;
  const attribution = PROJECT_ATTRIBUTION[species] ?? PROJECT_ATTRIBUTION.default;

  return {
    species: species.toLowerCase(),
    filePath: relativePath,
    fileBytes: fs.statSync(filePath).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    triangleCount: triangles,
    meshCount: meshes.length,
    meshNodeCount: meshNodes.length,
    primitiveCount,
    materialCount: (json.materials ?? []).length,
    usedMaterialCount: usedMaterials.size,
    nodeCount: nodes.length,
    nodeHierarchy: hierarchy(json),
    skinCount: skins.length,
    boneCount: boneIds.size,
    morphTargetCount,
    morphMeshes,
    animationClips: animations,
    namedComponents: components,
    structure: {
      hasUsableClip,
      hasSeparateRigidComponents,
      fusedStaticMesh,
      selectedAuthoringPath: hasUsableClip
        ? 'sample-source-clip'
        : (hasSeparateRigidComponents ? 'animate-rigid-components' : 'author-non-destructive-deformation-rig'),
    },
    attribution,
  };
}

function parseOutputPath() {
  const index = process.argv.indexOf('--json');
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error('--json requires an output path');
  return path.resolve(ROOT, value);
}

const report = {
  schemaVersion: 1,
  generatedBy: 'tools/inspect-forest-enemies.mjs',
  sourcePolicy: 'Original GLBs are read-only; derived animation assets must live outside assets/breakroom.',
  species: SPECIES.map(inspect),
};
const outputPath = parseOutputPath();
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized);
  console.log(path.relative(ROOT, outputPath));
} else {
  process.stdout.write(serialized);
}
