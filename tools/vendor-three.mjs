#!/usr/bin/env node

/**
 * Reproduce and verify the checked-in Three.js runtime used by the static app.
 *
 * Usage:
 *   node tools/vendor-three.mjs --update  # download, verify, and replace vendor/three
 *   node tools/vendor-three.mjs --check   # verify the existing vendored tree (default)
 *
 * The update path verifies the npm tarball against the pinned SRI before it is
 * extracted. The checked-in SHA-256 manifest covers every copied upstream file.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'three';
const VERSION = '0.185.1';
const SPECIFIER = `${PACKAGE_NAME}@${VERSION}`;
const NPM_INTEGRITY = 'sha512-5aojFCXKwnjBRZvUnt3WFfEcvUJgkN5LlijRFN95hMy8WVkG4I0QNcJE+OuWvuJ0bOdStrbfXn0pkd6/QyiAlg==';
const UPSTREAM_TAG = 'r185';
const UPSTREAM_COMMIT = '2431a09f46f34c560bc8e44b33be0e567723d5b9';
const TARBALL_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${VERSION}.tgz`;

const REQUIRED_FILES = [
  'LICENSE',
  'package.json',
  'build/three.core.js',
  'build/three.module.js',
  'build/three.webgpu.js',
  'build/three.tsl.js',
];

const METADATA_FILES = new Set(['manifest.json', 'MANIFEST.sha256']);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorParent = path.join(repoRoot, 'vendor');
const vendorRoot = path.join(vendorParent, PACKAGE_NAME);
const comparePaths = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function fail(message) {
  throw new Error(`[vendor-three] ${message}`);
}

function relativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(target) {
  const hash = createHash('sha256');
  hash.update(await readFile(target));
  return hash.digest('hex');
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => comparePaths(a.name, b.name))) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`symbolic links are not allowed: ${relativePath(root, absolutePath)}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, absolutePath));
    else if (entry.isFile()) files.push(relativePath(root, absolutePath));
    else fail(`unsupported filesystem entry: ${relativePath(root, absolutePath)}`);
  }

  return files.sort(comparePaths);
}

async function checksumEntries(root) {
  const files = (await listFiles(root)).filter((file) => !METADATA_FILES.has(file));
  const entries = [];
  let byteCount = 0;

  for (const file of files) {
    const absolutePath = path.join(root, file);
    const fileStat = await stat(absolutePath);
    byteCount += fileStat.size;
    entries.push({ file, bytes: fileStat.size, sha256: await sha256(absolutePath) });
  }

  return { entries, byteCount };
}

function expectedManifest(fileCount, byteCount) {
  return {
    schemaVersion: 1,
    package: PACKAGE_NAME,
    version: VERSION,
    npmSpecifier: SPECIFIER,
    npmIntegrity: NPM_INTEGRITY,
    npmTarball: TARBALL_URL,
    upstreamTag: UPSTREAM_TAG,
    upstreamCommit: UPSTREAM_COMMIT,
    selection: [
      'LICENSE',
      'package.json',
      'build/three.core.js',
      'build/three.module.js',
      'build/three.webgpu.js',
      'build/three.tsl.js',
      'examples/jsm/**',
    ],
    checksumAlgorithm: 'sha256',
    checksumFile: 'MANIFEST.sha256',
    officialFileCount: fileCount,
    officialByteCount: byteCount,
  };
}

async function writeMetadata(root) {
  const { entries, byteCount } = await checksumEntries(root);
  const manifest = expectedManifest(entries.length, byteCount);
  const checksums = entries.map(({ file, sha256: digest }) => `${digest}  ${file}`).join('\n');

  await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(root, 'MANIFEST.sha256'), `${checksums}\n`, 'utf8');
}

function parseChecksumManifest(raw) {
  const parsed = new Map();
  for (const line of raw.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) fail(`invalid checksum line: ${JSON.stringify(line)}`);
    if (parsed.has(match[2])) fail(`duplicate checksum entry: ${match[2]}`);
    parsed.set(match[2], match[1]);
  }
  return parsed;
}

async function verifyVendoredTree(root = vendorRoot) {
  for (const file of [...REQUIRED_FILES, 'manifest.json', 'MANIFEST.sha256']) {
    if (!await exists(path.join(root, file))) fail(`missing required file: ${file}`);
  }
  if (!await exists(path.join(root, 'examples/jsm'))) fail('missing required examples/jsm tree');

  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageJson.name !== PACKAGE_NAME) fail(`package name is ${packageJson.name}, expected ${PACKAGE_NAME}`);
  if (packageJson.version !== VERSION) fail(`package version is ${packageJson.version}, expected ${VERSION}`);

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const checksums = parseChecksumManifest(await readFile(path.join(root, 'MANIFEST.sha256'), 'utf8'));
  const { entries, byteCount } = await checksumEntries(root);
  const expected = expectedManifest(entries.length, byteCount);

  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    fail('manifest.json metadata or aggregate counts do not match the pinned configuration');
  }

  const actualFiles = entries.map(({ file }) => file);
  const listedFiles = [...checksums.keys()];
  if (JSON.stringify(listedFiles) !== JSON.stringify(actualFiles)) {
    fail('MANIFEST.sha256 file list differs from the vendored tree');
  }

  for (const entry of entries) {
    if (checksums.get(entry.file) !== entry.sha256) fail(`checksum mismatch: ${entry.file}`);
  }

  return {
    version: VERSION,
    files: entries.length,
    bytes: byteCount,
    mib: byteCount / (1024 * 1024),
  };
}

async function copySelectedPackageFiles(sourceRoot, stageRoot) {
  await mkdir(stageRoot, { recursive: true });

  for (const file of REQUIRED_FILES) {
    const source = path.join(sourceRoot, file);
    if (!await exists(source)) fail(`npm tarball is missing ${file}`);
    const destination = path.join(stageRoot, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }

  const examplesSource = path.join(sourceRoot, 'examples/jsm');
  if (!await exists(examplesSource)) fail('npm tarball is missing examples/jsm');
  await cp(examplesSource, path.join(stageRoot, 'examples/jsm'), { recursive: true });
}

async function replaceVendorTree(stageRoot) {
  const backupRoot = path.join(vendorParent, `.three-backup-${process.pid}`);
  let movedExisting = false;

  if (await exists(backupRoot)) fail(`refusing to overwrite unexpected backup: ${backupRoot}`);

  try {
    if (await exists(vendorRoot)) {
      await rename(vendorRoot, backupRoot);
      movedExisting = true;
    }
    await rename(stageRoot, vendorRoot);
    if (movedExisting) await rm(backupRoot, { recursive: true });
  } catch (error) {
    if (!await exists(vendorRoot) && movedExisting && await exists(backupRoot)) {
      await rename(backupRoot, vendorRoot);
    }
    throw error;
  }
}

async function updateVendorTree() {
  await mkdir(vendorParent, { recursive: true });
  const downloadRoot = await mkdtemp(path.join(tmpdir(), 'kitty-kaki-three-'));
  const stageRoot = path.join(vendorParent, `.three-stage-${process.pid}`);

  if (await exists(stageRoot)) fail(`refusing to overwrite unexpected stage directory: ${stageRoot}`);

  try {
    const npmOutput = execFileSync(
      'npm',
      ['pack', SPECIFIER, '--ignore-scripts', '--json', '--pack-destination', downloadRoot],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const packResult = JSON.parse(npmOutput);
    if (!Array.isArray(packResult) || packResult.length !== 1) fail('npm pack returned an unexpected result');
    if (packResult[0].name !== PACKAGE_NAME || packResult[0].version !== VERSION) {
      fail(`npm pack resolved ${packResult[0].name}@${packResult[0].version}, expected ${SPECIFIER}`);
    }
    if (packResult[0].integrity !== NPM_INTEGRITY) {
      fail(`npm reported integrity ${packResult[0].integrity}, expected ${NPM_INTEGRITY}`);
    }

    const tarballPath = path.join(downloadRoot, packResult[0].filename);
    const tarballBytes = await readFile(tarballPath);
    const actualIntegrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`;
    if (actualIntegrity !== NPM_INTEGRITY) {
      fail(`downloaded tarball integrity ${actualIntegrity}, expected ${NPM_INTEGRITY}`);
    }

    execFileSync('tar', ['-xzf', tarballPath, '-C', downloadRoot], { stdio: 'inherit' });
    const sourceRoot = path.join(downloadRoot, 'package');
    const packageJson = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
    if (packageJson.name !== PACKAGE_NAME || packageJson.version !== VERSION) {
      fail(`tarball contains ${packageJson.name}@${packageJson.version}, expected ${SPECIFIER}`);
    }

    await copySelectedPackageFiles(sourceRoot, stageRoot);
    await writeMetadata(stageRoot);
    const stagedReport = await verifyVendoredTree(stageRoot);
    await replaceVendorTree(stageRoot);
    return stagedReport;
  } finally {
    if (await exists(stageRoot)) await rm(stageRoot, { recursive: true });
    await rm(downloadRoot, { recursive: true });
  }
}

function printReport(action, report) {
  process.stdout.write(
    `[vendor-three] ${action} ${SPECIFIER}: ${report.files} official files, `
    + `${report.bytes} bytes (${report.mib.toFixed(2)} MiB)\n`,
  );
  process.stdout.write(`[vendor-three] npm integrity: ${NPM_INTEGRITY}\n`);
  process.stdout.write(`[vendor-three] upstream: ${UPSTREAM_TAG} @ ${UPSTREAM_COMMIT}\n`);
}

const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  process.stdout.write('Usage: node tools/vendor-three.mjs [--check|--update]\n');
  process.exit(0);
}
if (args.has('--check') && args.has('--update')) fail('choose either --check or --update');
for (const arg of args) {
  if (arg !== '--check' && arg !== '--update') fail(`unknown argument: ${arg}`);
}

const updating = args.has('--update');
const report = updating ? await updateVendorTree() : await verifyVendoredTree();
printReport(updating ? 'vendored and verified' : 'verified', report);
