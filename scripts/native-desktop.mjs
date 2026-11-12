import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const mode = process.argv[2];
const manifest = 'src-native/Cargo.toml';
const extension = process.platform === 'win32' ? '.exe' : '';
const launcher = `agentboard-native${extension}`;
const destination = resolve('dist/native');

function run(executable, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

if (mode === 'start') {
  process.exitCode = await run(join(destination, launcher), []);
} else {
  const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
  if (!triple) throw new Error('Could not identify the Rust host target.');
  const sidecar = resolve('src-tauri/binaries', `orchestrator-backend-${triple}${extension}`);
  const worklog = resolve('worklog.md');
  if (mode === 'dev') {
    // Windows locks the running executable. Keep the build output available to later builds.
    const directory = await mkdtemp(resolve('dist/native-dev-'));
    const executable = join(directory, `orchestrator-backend${extension}`);
    try {
      await copyFile(sidecar, executable);
      process.exitCode = await run('cargo', ['run', '--locked', '--manifest-path', manifest], {
        ...process.env,
        ORCHESTRATOR_SIDECAR: executable,
        ORCHESTRATOR_WORKLOG: worklog,
      });
    } finally {
      await unlink(executable).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(directory);
    }
  } else if (mode === 'package' || mode === 'dist') {
    execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', manifest], { stdio: 'inherit' });
    const { target_directory: target } = JSON.parse(execFileSync('cargo', [
      'metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest,
    ], { encoding: 'utf8' }));
    await mkdir(destination, { recursive: true });
    const resources = [
      [join(target, 'release', launcher), launcher],
      [sidecar, `orchestrator-backend${extension}`],
      [worklog, 'worklog.md'],
    ];
    await Promise.all(resources.map(([source, name]) => copyFile(source, join(destination, name))));
    console.log(`Native desktop application: ${destination}`);
    if (mode === 'dist') {
      const archive = resolve('dist', `Agentboard-${process.platform}-${process.arch}.tar.gz`);
      execFileSync('tar', ['-czf', archive, '-C', destination, ...resources.map(([, name]) => name)], { stdio: 'inherit' });
      console.log(`Portable archive: ${archive}`);
    }
  } else {
    throw new Error('Expected dev, start, package, or dist.');
  }
}
