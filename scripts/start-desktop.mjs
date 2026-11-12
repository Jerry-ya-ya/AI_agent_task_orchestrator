import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';

const { target_directory: targetDirectory } = JSON.parse(execFileSync('cargo', [
  'metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--no-deps', '--format-version', '1',
], { encoding: 'utf8' }));
const executable = process.platform === 'win32'
  ? 'ai-agent-task-orchestrator.exe'
  : 'ai-agent-task-orchestrator';
const child = spawn(join(targetDirectory, 'release', executable), { stdio: 'inherit' });
child.once('error', (error) => {
  console.error(`Unable to launch the desktop build. Run pnpm package first. ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code) => { process.exitCode = code ?? 1; });
