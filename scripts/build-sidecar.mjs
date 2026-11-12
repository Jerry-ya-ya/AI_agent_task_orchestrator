import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

if (Number(process.versions.node.split('.')[0]) < 26) {
  throw new Error('Building the desktop backend requires Node.js 26 or newer.');
}

const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? host;
const architecture = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
const platform = { win32: '-windows-', darwin: '-apple-darwin', linux: '-linux-' }[process.platform];
if (!architecture || !platform || !target?.startsWith(`${architecture}-`) || !target.includes(platform)) {
  throw new Error(`Build the sidecar with a Node.js binary matching the Tauri target (${target}).`);
}

const binaryDirectory = resolve('src-tauri/binaries');
const buildDirectory = resolve('dist/sidecar');
const executable = resolve(binaryDirectory, `orchestrator-backend-${target}${process.platform === 'win32' ? '.exe' : ''}`);
const entry = resolve(buildDirectory, 'desktop.cjs');
const configuration = resolve(buildDirectory, 'sea.json');
await Promise.all([mkdir(binaryDirectory, { recursive: true }), mkdir(buildDirectory, { recursive: true })]);

await build({
  entryPoints: ['dist/backend/backend/desktop.js'],
  outfile: entry,
  platform: 'node',
  target: 'node26',
  format: 'cjs',
  bundle: true,
});
await writeFile(configuration, JSON.stringify({
  main: entry,
  output: executable,
  disableExperimentalSEAWarning: true,
  execArgvExtension: 'none',
}));
execFileSync(process.execPath, [`--build-sea=${configuration}`], { stdio: 'inherit' });
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--force', '--sign', '-', executable], { stdio: 'inherit' });
}
