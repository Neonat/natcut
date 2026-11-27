import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const projectId = 'sprout-dev-66f08';
const databaseId = 'natcut';
const ascending = (fieldPath) => ({ fieldPath, order: 'ASCENDING' });
const required = [
  ['eventId', 'publicStatus', 'queueNumber'],
  ['eventId', 'queueNumber'],
].map((paths) => ({ collectionGroup: 'submissions', queryScope: 'COLLECTION', fields: paths.map(ascending) }));

function normalizeInventoryIndex(index) {
  if (typeof index?.name !== 'string') throw new Error('Each inventory index needs its full Firestore resource name.');
  const match = /^projects\/([^/]+)\/databases\/([^/]+)\/collectionGroups\/([^/]+)\/indexes\/([^/]+)$/.exec(index?.name);
  if (!match) throw new Error('Each inventory index needs its full Firestore resource name.');
  const [, project, database, collectionGroup] = match;
  if (project !== projectId || database !== databaseId) throw new Error(`Index belongs to the wrong project or database: ${index.name}`);
  if (index.collectionGroup !== undefined && index.collectionGroup !== collectionGroup) {
    throw new Error(`Collection group disagrees with resource name: ${index.name}`);
  }
  if (!Array.isArray(index.fields)) throw new Error(`Missing index fields: ${index.name}`);
  // Firestore may append the ascending document name to these ascending composites.
  const fields = isDeepStrictEqual(index.fields.at(-1), ascending('__name__')) ? index.fields.slice(0, -1) : index.fields;
  return { ...index, collectionGroup, fields };
}

export function verifyNatcutIndexes(specification, inventory) {
  if (!Array.isArray(specification?.indexes) || specification.indexes.length !== required.length ||
    !required.every((expected) => specification.indexes.some((entry) => isDeepStrictEqual(entry, expected))) ||
    !isDeepStrictEqual(specification.fieldOverrides, [])) {
    throw new Error('Checked-in specification must contain the two exact ascending NatCut submissions indexes.');
  }
  if (inventory?.projectId !== projectId || inventory?.databaseId !== databaseId) {
    throw new Error(`Inventory must identify project ${projectId} and database ${databaseId}.`);
  }
  if (!Array.isArray(inventory.indexes)) throw new Error('Inventory must contain an indexes array.');
  const indexes = inventory.indexes.map(normalizeInventoryIndex);
  const resourceNames = new Set(indexes.map((index) => index.name));
  if (resourceNames.size !== indexes.length) throw new Error('Inventory contains a duplicate index resource name.');
  return required.map((expected) => {
    const matches = indexes.filter((entry) =>
      entry.collectionGroup === expected.collectionGroup && entry.queryScope === expected.queryScope &&
      (entry.apiScope === undefined || entry.apiScope === 'ANY_API') &&
      (entry.density === undefined || entry.density === 'SPARSE_ALL') &&
      isDeepStrictEqual(entry.fields, expected.fields));
    if (matches.length > 1) throw new Error(`Duplicate inventory entries for ${expected.fields.map((f) => f.fieldPath).join(', ')}.`);
    const rawState = matches.length ? matches[0].state : 'MISSING';
    const state = typeof rawState === 'string' && ['MISSING', 'CREATING', 'READY', 'NEEDS_REPAIR'].includes(rawState)
      ? rawState
      : 'UNKNOWN';
    return { fields: expected.fields.map((field) => field.fieldPath), state: state === 'CREATING' ? 'BUILDING' : state };
  });
}

async function main(args) {
  if (args.length !== 2 || args[0] !== '--inventory' || !args[1] || args[1].startsWith('-')) {
    throw new Error('Usage: npm run verify:indexes -- --inventory <local-json-file>');
  }
  const [specification, inventory] = await Promise.all([
    readFile(new URL('../firestore.indexes.json', import.meta.url), 'utf8'), readFile(args[1], 'utf8'),
  ]);
  const rows = verifyNatcutIndexes(JSON.parse(specification), JSON.parse(inventory));
  console.log(`Inventory for ${projectId} / ${databaseId}`);
  for (const { fields, state } of rows) console.log(`${state}  submissions (${fields.map((f) => f + ' ASC').join(', ')})`);
  if (rows.some((row) => row.state !== 'READY')) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
