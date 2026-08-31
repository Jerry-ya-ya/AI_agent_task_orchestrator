import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ProcessResult, TestExecutionResult } from '../domain/types.js';
import {
  ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunnerLike
} from '../infra/process-runner.js';

const DEFAULT_TEST_TIMEOUT_MS = 15 * 60 * 1_000;
const TEST_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

export interface DetectedTestCommand {
  command: string;
  args: readonly string[];
  description: string;
  kind: 'test' | 'build';
  windowsVerbatimArguments?: boolean;
}

export interface TestServiceOptions {
  timeoutMs?: number;
}

/** Runs one conservative test/build command, or reports that review is unverified. */
export class TestService {
  private readonly timeoutMs: number;

  public constructor(
    private readonly processRunner: ProcessRunnerLike = new ProcessRunner(),
    options: TestServiceOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  }

  public async execute(workspace: string, signal?: AbortSignal): Promise<TestExecutionResult> {
    let command: DetectedTestCommand | null;
    try {
      command = await this.detectCommand(workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unverifiedWithoutProcess(`Verification configuration could not be inspected: ${message}`);
    }

    if (command === null) {
      return unverifiedWithoutProcess(
        'No supported test or build command was detected. Review the changes manually.'
      );
    }

    let result: ProcessResult;
    try {
      const executableCommand = await resolvePlatformCommand(command);
      const options: ProcessRunOptions = {
        command: executableCommand.command,
        args: executableCommand.args,
        cwd: path.resolve(workspace),
        signal,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: TEST_OUTPUT_LIMIT_BYTES,
        env: {
          ...process.env,
          CI: 'true',
          FORCE_COLOR: '0',
          NG_CLI_ANALYTICS: 'false'
        },
        windowsVerbatimArguments: executableCommand.windowsVerbatimArguments
      };
      result = await this.processRunner.run(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unverifiedWithoutProcess(
        `${command.description} was detected but could not be started: ${message}`
      );
    }

    return {
      ...result,
      executed: true,
      verificationKind: command.kind,
      commandDescription: command.description,
      summary: summarizeVerificationResult(result, command.kind)
    };
  }

  /** Alias retained for composition code that names the operation `run`. */
  public async run(workspace: string, signal?: AbortSignal): Promise<TestExecutionResult> {
    return await this.execute(workspace, signal);
  }

  public async detectCommand(workspace: string): Promise<DetectedTestCommand | null> {
    const root = path.resolve(workspace);
    const metadata = await stat(root);
    if (!metadata.isDirectory()) {
      throw new Error('Test workspace must be a directory.');
    }

    const packageJsonPath = path.join(root, 'package.json');
    if (await fileExists(packageJsonPath)) {
      const packageMetadata = await readPackageMetadata(packageJsonPath);
      const packageManager = await detectPackageManager(root, packageMetadata.packageManager);

      if (await fileExists(path.join(root, 'angular.json'))) {
        if (packageMetadata.hasTestScript) {
          return packageScriptCommand(packageManager, true);
        }
        if (await angularHasTarget(path.join(root, 'angular.json'), 'test')) {
          return angularCliTestCommand(packageManager);
        }
        if (packageMetadata.hasBuildScript) {
          return packageBuildCommand(packageManager);
        }
        if (await angularHasTarget(path.join(root, 'angular.json'), 'build')) {
          return angularCliBuildCommand(packageManager);
        }
      }

      if (packageMetadata.hasTestScript) {
        return packageScriptCommand(packageManager, false);
      }
      if (packageMetadata.hasBuildScript) {
        return packageBuildCommand(packageManager);
      }
    }

    const gradle = await detectGradleWrapper(root);
    if (gradle !== null) {
      return gradle;
    }

    const maven = await detectMavenWrapper(root);
    if (maven !== null) {
      return maven;
    }

    if (await isPytestProject(root)) {
      return {
        command: await pythonExecutable(root),
        args: ['-m', 'pytest'],
        description: 'pytest',
        kind: 'test'
      };
    }

    if (await fileExists(path.join(root, 'Cargo.toml'))) {
      return { command: 'cargo', args: ['test'], description: 'Cargo tests', kind: 'test' };
    }

    if (await fileExists(path.join(root, 'go.mod'))) {
      return { command: 'go', args: ['test', './...'], description: 'Go tests', kind: 'test' };
    }

    const dotnetTarget = await findDotnetTarget(root);
    if (dotnetTarget !== null) {
      return {
        command: 'dotnet',
        args: ['test', dotnetTarget, '--nologo'],
        description: `dotnet test ${path.basename(dotnetTarget)}`,
        kind: 'test'
      };
    }

    return null;
  }
}

interface PackageMetadata {
  hasTestScript: boolean;
  hasBuildScript: boolean;
  packageManager: string | undefined;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

async function readPackageMetadata(packageJsonPath: string): Promise<PackageMetadata> {
  const source = await readFile(packageJsonPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('package.json is not valid JSON.');
  }

  if (!isRecord(parsed)) {
    throw new Error('package.json must contain an object.');
  }

  const scripts = isRecord(parsed['scripts']) ? parsed['scripts'] : undefined;
  const testScript = scripts?.['test'];
  const buildScript = scripts?.['build'];
  return {
    hasTestScript: isUsableTestScript(testScript),
    hasBuildScript: typeof buildScript === 'string' && buildScript.trim().length > 0,
    packageManager:
      typeof parsed['packageManager'] === 'string' ? parsed['packageManager'] : undefined
  };
}

function isUsableTestScript(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  return !/no test specified/iu.test(value);
}

async function angularHasTarget(
  angularJsonPath: string,
  targetName: 'test' | 'build'
): Promise<boolean> {
  const source = await readFile(angularJsonPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('angular.json is not valid JSON.');
  }
  const projects = asRecord(parsed)?.['projects'];
  const projectMap = asRecord(projects);
  if (projectMap === null) {
    return false;
  }
  return Object.values(projectMap).some((project) => {
    const projectRecord = asRecord(project);
    const targets = asRecord(projectRecord?.['targets']) ?? asRecord(projectRecord?.['architect']);
    return targets !== null && targetName in targets;
  });
}

async function detectPackageManager(
  root: string,
  packageManagerField: string | undefined
): Promise<PackageManager> {
  const declaredName = packageManagerField?.split('@', 1)[0];
  if (
    declaredName === 'npm' ||
    declaredName === 'pnpm' ||
    declaredName === 'yarn' ||
    declaredName === 'bun'
  ) {
    return declaredName;
  }

  if (await fileExists(path.join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await fileExists(path.join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  if (
    (await fileExists(path.join(root, 'bun.lock'))) ||
    (await fileExists(path.join(root, 'bun.lockb')))
  ) {
    return 'bun';
  }
  return 'npm';
}

function packageScriptCommand(
  manager: PackageManager,
  angular: boolean
): DetectedTestCommand {
  const extraArgs = angular ? ['--watch=false'] : [];
  switch (manager) {
    case 'pnpm':
      return {
        command: 'pnpm',
        args: ['run', 'test', ...(angular ? ['--', ...extraArgs] : [])],
        description: angular ? 'Angular tests (pnpm, non-watch)' : 'Package tests (pnpm)',
        kind: 'test'
      };
    case 'yarn':
      return {
        command: 'yarn',
        args: ['run', 'test', ...extraArgs],
        description: angular ? 'Angular tests (Yarn, non-watch)' : 'Package tests (Yarn)',
        kind: 'test'
      };
    case 'bun':
      return {
        command: 'bun',
        args: ['run', 'test', ...extraArgs],
        description: angular ? 'Angular tests (Bun, non-watch)' : 'Package tests (Bun)',
        kind: 'test'
      };
    case 'npm':
      return {
        command: 'npm',
        args: ['run', 'test', ...(angular ? ['--', ...extraArgs] : [])],
        description: angular ? 'Angular tests (npm, non-watch)' : 'Package tests (npm)',
        kind: 'test'
      };
  }
}

function packageBuildCommand(manager: PackageManager): DetectedTestCommand {
  switch (manager) {
    case 'pnpm':
      return {
        command: 'pnpm',
        args: ['run', 'build'],
        description: 'Package build (pnpm)',
        kind: 'build'
      };
    case 'yarn':
      return {
        command: 'yarn',
        args: ['run', 'build'],
        description: 'Package build (Yarn)',
        kind: 'build'
      };
    case 'bun':
      return {
        command: 'bun',
        args: ['run', 'build'],
        description: 'Package build (Bun)',
        kind: 'build'
      };
    case 'npm':
      return {
        command: 'npm',
        args: ['run', 'build'],
        description: 'Package build (npm)',
        kind: 'build'
      };
  }
}

function angularCliTestCommand(manager: PackageManager): DetectedTestCommand {
  switch (manager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', 'ng', 'test', '--watch=false'], description: 'Angular CLI tests (pnpm, non-watch)', kind: 'test' };
    case 'yarn':
      return { command: 'yarn', args: ['exec', 'ng', 'test', '--watch=false'], description: 'Angular CLI tests (Yarn, non-watch)', kind: 'test' };
    case 'bun':
      return { command: 'bun', args: ['run', 'ng', 'test', '--watch=false'], description: 'Angular CLI tests (Bun, non-watch)', kind: 'test' };
    case 'npm':
      return { command: 'npm', args: ['exec', '--offline', '--', 'ng', 'test', '--watch=false'], description: 'Angular CLI tests (npm, non-watch)', kind: 'test' };
  }
}

function angularCliBuildCommand(manager: PackageManager): DetectedTestCommand {
  switch (manager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', 'ng', 'build'], description: 'Angular CLI build (pnpm)', kind: 'build' };
    case 'yarn':
      return { command: 'yarn', args: ['exec', 'ng', 'build'], description: 'Angular CLI build (Yarn)', kind: 'build' };
    case 'bun':
      return { command: 'bun', args: ['run', 'ng', 'build'], description: 'Angular CLI build (Bun)', kind: 'build' };
    case 'npm':
      return { command: 'npm', args: ['exec', '--offline', '--', 'ng', 'build'], description: 'Angular CLI build (npm)', kind: 'build' };
  }
}

async function detectGradleWrapper(root: string): Promise<DetectedTestCommand | null> {
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const wrapperPath = path.join(root, wrapper);
  if (!(await fileExists(wrapperPath))) {
    return null;
  }
  return wrapperCommand(wrapperPath, ['test', '--no-daemon'], 'Gradle wrapper tests', 'test');
}

async function detectMavenWrapper(root: string): Promise<DetectedTestCommand | null> {
  const wrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
  const wrapperPath = path.join(root, wrapper);
  if (!(await fileExists(wrapperPath))) {
    return null;
  }
  return wrapperCommand(wrapperPath, ['test', '--batch-mode'], 'Maven wrapper tests', 'test');
}

function wrapperCommand(
  wrapperPath: string,
  args: readonly string[],
  description: string,
  kind: 'test' | 'build'
): DetectedTestCommand {
  if (process.platform !== 'win32') {
    return { command: '/bin/sh', args: [wrapperPath, ...args], description, kind };
  }

  return windowsCommandShim(wrapperPath, args, description, kind);
}

/**
 * Windows package managers are commonly installed as .cmd shims, which
 * CreateProcess cannot execute directly when spawn uses shell:false. Resolve
 * only from PATH, then invoke a fixed cmd.exe with a strictly quoted command.
 */
async function resolvePlatformCommand(
  command: DetectedTestCommand
): Promise<DetectedTestCommand> {
  if (process.platform !== 'win32') {
    return command;
  }

  const resolvedCommand = path.isAbsolute(command.command)
    ? command.command
    : await resolveFromWindowsPath(command.command);
  const extension = path.extname(resolvedCommand).toLowerCase();
  if (extension === '.cmd' || extension === '.bat') {
    return windowsCommandShim(resolvedCommand, command.args, command.description, command.kind);
  }
  return { ...command, command: resolvedCommand };
}

async function resolveFromWindowsPath(command: string): Promise<string> {
  if (!/^[a-z0-9._-]+$/iu.test(command)) {
    throw new Error(`Unsafe executable name: ${command}`);
  }

  const environmentPath = process.env['PATH'] ?? process.env['Path'] ?? '';
  const configuredExtensions = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.toLowerCase())
    .filter((extension) => ['.com', '.exe', '.bat', '.cmd'].includes(extension));
  const extensions = path.extname(command).length > 0 ? [''] : configuredExtensions;

  for (const rawDirectory of environmentPath.split(path.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, '');
    if (directory.length === 0 || directory.includes('\0')) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${command}${extension}`);
      try {
        if ((await stat(candidate)).isFile()) {
          return await realpath(candidate);
        }
      } catch {
        // Continue through the explicit PATH entries.
      }
    }
  }
  throw new Error(`Unable to locate ${command} in PATH.`);
}

function windowsCommandShim(
  scriptPath: string,
  args: readonly string[],
  description: string,
  kind: 'test' | 'build'
): DetectedTestCommand {
  const tokens = [scriptPath, ...args];
  if (tokens.some((token) => /["&|<>^%!\r\n\0]/u.test(token))) {
    throw new Error('Windows command shim contains characters that cannot be quoted safely.');
  }

  const commandLine = tokens.map((token) => `"${token}"`).join(' ');
  return {
    command: safeComSpec(),
    args: ['/d', '/v:off', '/s', '/c', `"${commandLine}"`],
    description,
    kind,
    windowsVerbatimArguments: true
  };
}

function safeComSpec(): string {
  const configured = process.env['ComSpec'];
  if (
    configured !== undefined &&
    path.isAbsolute(configured) &&
    path.basename(configured).toLowerCase() === 'cmd.exe'
  ) {
    return configured;
  }

  const systemRoot = process.env['SystemRoot'];
  if (systemRoot !== undefined && path.isAbsolute(systemRoot)) {
    return path.join(systemRoot, 'System32', 'cmd.exe');
  }
  return 'C:\\Windows\\System32\\cmd.exe';
}

async function isPytestProject(root: string): Promise<boolean> {
  for (const filename of ['pytest.ini', 'tox.ini', 'setup.cfg']) {
    if (await fileExists(path.join(root, filename))) {
      return true;
    }
  }

  const pyprojectPath = path.join(root, 'pyproject.toml');
  if (await fileExists(pyprojectPath)) {
    const source = await readFile(pyprojectPath, 'utf8');
    return /(?:^|\n)\s*\[tool\.pytest(?:\.|\])/u.test(source) || /pytest/u.test(source);
  }

  const requirementsPath = path.join(root, 'requirements.txt');
  if (await fileExists(requirementsPath)) {
    const source = await readFile(requirementsPath, 'utf8');
    return /(?:^|\n)\s*pytest(?:\s|[<>=!~;#]|$)/iu.test(source);
  }

  return await directoryExists(path.join(root, 'tests'));
}

async function pythonExecutable(root: string): Promise<string> {
  const virtualEnvironmentPython =
    process.platform === 'win32'
      ? path.join(root, '.venv', 'Scripts', 'python.exe')
      : path.join(root, '.venv', 'bin', 'python');
  return (await fileExists(virtualEnvironmentPython))
    ? virtualEnvironmentPython
    : process.platform === 'win32'
      ? 'python'
      : 'python3';
}

async function findDotnetTarget(root: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true });
  const supportedExtensions = ['.slnx', '.sln', '.csproj'];
  for (const extension of supportedExtensions) {
    const match = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
      .map((entry) => entry.name)
      .sort((first, second) => first.localeCompare(second))[0];
    if (match !== undefined) {
      return path.join(root, match);
    }
  }
  return null;
}

function summarizeVerificationResult(
  result: ProcessResult,
  kind: 'test' | 'build'
): string {
  const label = kind === 'test' ? 'Tests' : 'Build';
  if (result.timedOut) {
    return `${label} timed out.`;
  }
  if (result.aborted) {
    return `${label} was cancelled.`;
  }
  if (result.exitCode === 0) {
    return kind === 'test' ? 'Tests passed.' : 'Build passed.';
  }

  const detail = lastNonEmptyLine(result.stderr) ?? lastNonEmptyLine(result.stdout);
  const suffix = detail === undefined ? '' : ` ${truncate(detail, 300)}`;
  return `${label} failed with exit code ${result.exitCode}.${suffix}`;
}

function unverifiedWithoutProcess(message: string): TestExecutionResult {
  const warning = `UNVERIFIED: ${message}`;
  return {
    exitCode: 0,
    stdout: `${warning}\n`,
    stderr: '',
    timedOut: false,
    aborted: false,
    executed: false,
    verificationKind: 'none',
    summary: warning,
    commandDescription: 'No verification command executed'
  };
}

function lastNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

async function fileExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}
