import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateDeployArguments(args) {
  if (args.length > 0) throw new Error('NatCut Hosting deploy does not accept arguments or target overrides.');
}

export async function deployHosting(args = process.argv.slice(2)) {
  validateDeployArguments(args);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn('firebase', [
    'deploy',
    '--config', 'firebase.json',
    '--project', 'sprout-dev-66f08',
    '--only', 'hosting:natcut',
    '--non-interactive',
  ], { cwd: repoRoot, stdio: 'inherit', shell: false });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Firebase deploy stopped by ${signal}.`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`Firebase Hosting deploy failed with exit code ${exitCode}.`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) await deployHosting();
