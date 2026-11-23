const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);

if (major < 24 || (major === 24 && minor < 12)) {
  console.error(
    `NatCut requires Node.js 24.12 or newer; this shell is using ${process.version}. ` +
    'Switch to the version in .nvmrc/.node-version before continuing.',
  );
  process.exit(1);
}
