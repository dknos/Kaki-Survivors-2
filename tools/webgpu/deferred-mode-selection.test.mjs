import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(ROOT, 'tools/webgpu/baseline.mjs'), 'utf8');

test('Catastrophe remains available explicitly but is excluded from the active mode suite', () => {
  assert.match(
    source,
    /\{ id: 'kaki-catastrophe',[^\n]+selector: 'catastrophe', deferred: true \}/,
    'the archived QA selector must remain addressable for later migration work',
  );
  const modes = source.match(/modes: Object\.freeze\(\[([\s\S]*?)\]\),/)?.[1] || '';
  assert.ok(modes.includes("'bullet-hell'"));
  assert.ok(modes.includes("'kaki-trials'"));
  assert.ok(!modes.includes('kaki-catastrophe'));
  assert.match(source, /if \(!row\.deferred\) requestedIds\.add\(row\.id\)/);
});
