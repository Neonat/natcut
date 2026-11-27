import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyNatcutIndexes } from '../scripts/verify-natcut-indexes.mjs';

const projectId = 'sprout-dev-66f08';
const databaseId = 'natcut';
const spec = JSON.parse(await readFile(new URL('../firestore.indexes.json', import.meta.url), 'utf8'));
const required = [['eventId', 'publicStatus', 'queueNumber'], ['eventId', 'queueNumber']];
const field = (fieldPath) => ({ fieldPath, order: 'ASCENDING' });
function inventory() {
  return { projectId, databaseId, indexes: required.map((paths, i) => ({
    name: `projects/${projectId}/databases/${databaseId}/collectionGroups/submissions/indexes/${i}`,
    queryScope: 'COLLECTION', fields: [...paths, '__name__'].map(field), state: 'READY',
  })) };
}
const states = (input) => verifyNatcutIndexes(spec, input).map((row) => row.state);

test('reports ready for the two exact indexes, including the implicit ascending document name', () => {
  const input = inventory();
  input.indexes[0].fields.pop();
  assert.deepEqual(states(input), ['READY', 'READY']);
});

test('reports each missing, building, and failed index', () => {
  const input = inventory();
  input.indexes.pop();
  input.indexes[0].state = 'CREATING';
  assert.deepEqual(states(input), ['BUILDING', 'MISSING']);
  input.indexes[0].state = 'NEEDS_REPAIR';
  assert.deepEqual(states(input), ['NEEDS_REPAIR', 'MISSING']);
  input.indexes[0].state = ['READY'];
  assert.deepEqual(states(input), ['UNKNOWN', 'MISSING']);
});

test('rejects inventory from another project or database even when the wrapper has the right labels', () => {
  for (const [key, wrong] of [['projectId', 'wrong'], ['databaseId', '(default)'], ['databaseId', 'other']]) {
    const input = inventory();
    assert.throws(() => states({ ...input, [key]: wrong }), /project|database/i);
    const before = key === 'projectId' ? `projects/${projectId}/` : `databases/${databaseId}/`;
    const after = key === 'projectId' ? `projects/${wrong}/` : `databases/${wrong}/`;
    input.indexes[1].name = input.indexes[1].name.replace(before, after);
    assert.throws(() => states(input), /project|database/i);
  }
});

test('rejects an inventory entry with missing or contradictory resource identity', () => {
  const input = inventory();
  input.indexes[0].collectionGroup = 'other';
  assert.throws(() => states(input), /collection/i);
  delete input.indexes[0].name;
  assert.throws(() => states(input), /name/i);
});

test('rejects reuse of one Firestore index resource identity for multiple definitions', () => {
  const input = inventory();
  input.indexes[1].name = input.indexes[0].name;
  assert.throws(() => states(input), /duplicate.*resource/i);
  input.indexes[1].name = [input.indexes[0].name];
  assert.throws(() => states(input), /resource name/i);
});

test('requires exact collection, scope, field order, field modes and direction', () => {
  for (const alter of [
    (row) => { row.name = row.name.replace('submissions', 'other'); },
    (row) => { row.queryScope = 'COLLECTION_GROUP'; },
    (row) => { row.apiScope = 'DATASTORE_MODE_API'; },
    (row) => { row.fields.reverse(); },
    (row) => { row.fields[0].arrayConfig = 'CONTAINS'; },
    (row) => { row.fields[0].order = 'DESCENDING'; },
    (row) => { row.fields.at(-1).order = 'DESCENDING'; },
  ]) {
    const input = inventory();
    alter(input.indexes[0]);
    assert.deepEqual(states(input), ['MISSING', 'READY']);
  }
});

test('rejects a changed repository index specification', () => {
  const changed = structuredClone(spec);
  changed.indexes[0].fields.reverse();
  assert.throws(() => verifyNatcutIndexes(changed, inventory()), /specification/i);
});

test('the CLI reads the supplied file, reports both states, and fails closed on extra flags', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'natcut-indexes-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const filename = join(temp, 'inventory.json');
  const cli = new URL('../scripts/verify-natcut-indexes.mjs', import.meta.url);
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(cli), ...args], { cwd: temp, encoding: 'utf8' });
  const input = inventory();
  await writeFile(filename, JSON.stringify(input));
  assert.equal(run('--inventory', filename).status, 0);
  input.indexes.pop();
  input.indexes[0].state = 'CREATING';
  await writeFile(filename, JSON.stringify(input));
  const unready = run('--inventory', filename);
  assert.notEqual(unready.status, 0);
  assert.match(unready.stdout, /BUILDING.*publicStatus/);
  assert.match(unready.stdout, /MISSING.*eventId.*queueNumber/);
  for (const args of [[], ['--inventory', '--deploy'], ['--inventory', filename, '--apply'], ['--project', 'other'], ['--delete']]) {
    const rejected = run(...args);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /usage/i);
  }
});
