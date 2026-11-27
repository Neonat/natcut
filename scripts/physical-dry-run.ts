import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseArtifactReceipt, verifyArtifactBytes } from '@natcut/artifacts/reader';
import { publishPhysicalDryRun } from '@natcut/printer';

const usage = 'Usage: npm run physical:dry-run -- --receipt <receipt.json> --bundle <bundle.bin> --out <new-directory>';

export async function runPhysicalDryRunCli(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      receipt: { type: 'string' },
      bundle: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.receipt || !values.bundle || !values.out) throw new Error(usage);
  let receipt;
  try {
    receipt = parseArtifactReceipt(JSON.parse(await readFile(values.receipt, 'utf8')));
  } catch (cause) {
    throw new Error('Invalid artifact receipt.', { cause });
  }
  const verified = await verifyArtifactBytes(new Uint8Array(await readFile(values.bundle)), receipt);
  await publishPhysicalDryRun(verified, values.out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhysicalDryRunCli()
    .then(() => console.log('Created physical adapter dry-run; no printer command sent.'))
    .catch((cause) => {
      console.error(cause instanceof Error ? cause.message : cause);
      process.exitCode = 1;
    });
}
