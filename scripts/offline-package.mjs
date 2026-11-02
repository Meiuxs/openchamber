#!/usr/bin/env node
// Build the offline intranet delivery package end to end: build the SDK and
// the web package, pack both npm tarballs, bundle the delivery zip with the
// platform install scripts, and optionally install and start it locally —
// the same flow an intranet machine runs from install.ps1 / install.sh.
//
// Usage:
//   node scripts/offline-package.mjs                    # build + pack + zip
//   node scripts/offline-package.mjs --skip-build       # pack + zip from the current build
//   node scripts/offline-package.mjs --install          # + install the tarballs globally
//   node scripts/offline-package.mjs --install --start --port 3001
//
// The zip lands at the repository root as openchamber-intranet-<version>.zip
// (gitignored, like every delivery zip). The zip carries:
//   openchamber-sdk-<version>.tgz   @openchamber/sdk, exact dependency of web
//   openchamber-web-<version>.tgz   @openchamber/web, the server + CLI
//   install.ps1 / install.sh        platform installers (scripts/delivery)
//   INSTALL.txt                     manual install, configuration, start commands
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deliveryDir = path.join(repoRoot, 'scripts', 'delivery');
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
};

const skipBuild = has('--skip-build');
const install = has('--install');
const start = has('--start');
const port = value('--port');

// One shell string per step: spawning an args array with shell:true only
// concatenates it (DEP0190), and the commands differ per platform anyway.
const run = (command, { cwd = repoRoot } = {}) => {
  console.log(`> ${command}`);
  const result = spawnSync(command, { stdio: 'inherit', shell: true, cwd });
  if (result.status !== 0) {
    console.error(`command failed with exit ${result.status}`);
    process.exit(result.status ?? 1);
  }
};

const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/web/package.json'), 'utf8')).version;
const sdkTgz = path.join(repoRoot, 'packages', 'sdk', `openchamber-sdk-${version}.tgz`);
const webTgz = path.join(repoRoot, 'packages', 'web', `openchamber-web-${version}.tgz`);
console.log(`OpenChamber ${version} offline package`);

if (!skipBuild) {
  // The SDK build must precede the web build: web's prepack rebuilds the
  // built-in extensions, which validate against the SDK's own build.
  run('bun run --cwd packages/sdk build');
  run('bun run build:web');
}
// bun pm pack rewrites the `workspace:*` dependency on @openchamber/sdk to the
// exact version; npm pack would leave the link in and the tarball would not install.
// --ignore-scripts skips web's prepack: build:web already built the built-in
// extensions, and packing must not depend on rebuilding them.
run('bun pm pack --ignore-scripts --cwd packages/sdk');
run('bun pm pack --ignore-scripts --cwd packages/web');
for (const file of [sdkTgz, webTgz]) {
  if (!fs.existsSync(file)) {
    console.error(`missing tarball: ${file}`);
    process.exit(1);
  }
}

const zipPath = path.join(repoRoot, `openchamber-intranet-${version}.zip`);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
const inputs = [sdkTgz, webTgz, 'install.ps1', 'install.sh', 'INSTALL.txt', 'RELEASE-NOTES.md'].map((name) => name.includes(path.sep) ? name : path.join(deliveryDir, name));
if (process.platform === 'win32') {
  run(`powershell -NoProfile -Command "Compress-Archive -Path '${inputs.join("','")}' -DestinationPath '${zipPath}' -Force"`);
} else {
  run(`zip -j ${zipPath} ${inputs.map((input) => `'${input}'`).join(' ')}`);
}
console.log(`delivery zip: ${zipPath} (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)`);

if (install) {
  // Same order install.ps1 uses: the SDK tarball seeds the npm cache so the
  // web package resolves its exact "@openchamber/sdk" dependency from cache;
  // --prefer-offline still reaches the registry for everything else.
  run(`npm install -g "${sdkTgz}"`);
  run(`npm install -g --prefer-offline "${webTgz}"`);
}

if (start) {
  const listenPort = port ?? '3000';
  const child = spawn(port ? `openchamber --port ${port}` : 'openchamber', { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.unref();
  console.log(`openchamber starting detached on port ${listenPort} (pid ${child.pid}); open http://localhost:${listenPort}`);
} else if (install) {
  console.log('installed. start with: openchamber  (or rerun with --start --port 3001)');
}
