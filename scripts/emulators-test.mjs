import { spawn } from 'node:child_process';

const requested = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : 'submission';

if (requested !== 'submission') {
  console.error(`Unknown emulator test target: ${requested}`);
  process.exitCode = 2;
} else {
  const command = [
    'firebase',
    'emulators:exec',
    '--project',
    'demo-natcut',
    '--only',
    'auth,firestore',
    'npm run test:unit -- --project submission',
  ];
  const javaHome = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
  const child = spawn('npx', command, {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, JAVA_HOME: javaHome, PATH: `${javaHome}/bin:${process.env.PATH ?? ''}` },
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
