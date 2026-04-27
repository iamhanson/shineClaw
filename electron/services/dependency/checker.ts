/**
 * Dependency checker — unified probe for git, node, openclaw, python.
 *
 * Each check function spawns the tool with --version (or equivalent) and
 * parses the output. Timeout is 3s per probe. The checker first looks in
 * ~/.shan/runtime/ (managed), then falls back to system PATH.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DepStatus, DependencySnapshot } from './types';
import { getManagedBinaryPath } from './runtime-paths';
import { getOpenClawStatus } from '../../utils/paths';
import { checkUvInstalled, isPythonReady } from '../../utils/uv-setup';
import { logger } from '../../utils/logger';

const PROBE_TIMEOUT_MS = 3000;

/**
 * Spawn a command and capture stdout. Returns null on timeout or error.
 */
async function trySpawn(
  command: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(null);
      }
    });

    child.on('error', () => resolve(null));
  });
}

/**
 * Check git availability. Tries managed path first, then system PATH.
 */
async function checkGit(): Promise<DepStatus> {
  const managed = getManagedBinaryPath('git');
  let version: string | undefined;
  let source: DepStatus['source'] = 'missing';
  let detail: string | undefined;

  // Try managed first
  if (managed) {
    const out = await trySpawn(managed, ['--version']);
    if (out) {
      const match = /git version ([\d.]+)/.exec(out);
      version = match?.[1] ?? out.split('\n')[0];
      source = 'managed';
    }
  }

  // Fallback to system
  if (!version) {
    const out = await trySpawn('git', ['--version']);
    if (out) {
      const match = /git version ([\d.]+)/.exec(out);
      version = match?.[1] ?? out.split('\n')[0];
      source = 'system';
    } else {
      detail = 'git not found in PATH';
    }
  }

  const autoInstallable = process.platform === 'darwin' || process.platform === 'win32';
  const manualHint =
    process.platform === 'linux' ? 'sudo apt install git  # or yum/dnf/pacman' : undefined;

  return {
    kind: 'git',
    installed: !!version,
    version,
    source,
    required: true,
    estimatedBytes: process.platform === 'win32' ? 50 * 1024 * 1024 : undefined,
    detail,
    autoInstallable,
    manualHint,
  };
}

/**
 * Check node availability. Requires version >= 18.
 */
async function checkNode(): Promise<DepStatus> {
  const managed = getManagedBinaryPath('node');
  let version: string | undefined;
  let source: DepStatus['source'] = 'missing';
  let detail: string | undefined;

  // Try managed first
  if (managed) {
    const out = await trySpawn(managed, ['--version']);
    if (out) {
      version = out.replace(/^v/, '');
      source = 'managed';
    }
  }

  // Fallback to system
  if (!version) {
    const out = await trySpawn('node', ['--version']);
    if (out) {
      version = out.replace(/^v/, '');
      source = 'system';
    } else {
      detail = 'node not found in PATH';
    }
  }

  // Validate version >= 18
  if (version) {
    const major = parseInt(version.split('.')[0], 10);
    if (major < 18) {
      detail = `node ${version} is too old (require >= 18)`;
      version = undefined;
      source = 'missing';
    }
  }

  return {
    kind: 'node',
    installed: !!version,
    version,
    source,
    required: true,
    estimatedBytes: 30 * 1024 * 1024,
    detail,
    autoInstallable: true,
    manualHint: undefined,
  };
}

/**
 * Check openclaw CLI availability.
 *
 * "Installed" means the user can run `openclaw` from a normal terminal — i.e.
 * a real global install (~/.local/bin, /usr/local/bin) or a Windows installer
 * registered command. We deliberately ignore project-local ./node_modules/.bin
 * resolution because that PATH entry is only present when the dev server
 * launches Electron, not in the user's shell.
 */
async function checkOpenClaw(): Promise<DepStatus> {
  const status = getOpenClawStatus();
  let version: string | undefined;
  let source: DepStatus['source'] = 'missing';
  let detail: string | undefined;
  let cliInvocable = false;
  let foundAt: string | undefined;

  const platform = process.platform;
  const candidatePaths: string[] = [];

  if (platform === 'darwin' || platform === 'linux') {
    candidatePaths.push(join(homedir(), '.local', 'bin', 'openclaw'));
    candidatePaths.push('/usr/local/bin/openclaw');
    candidatePaths.push('/opt/homebrew/bin/openclaw');
  } else if (platform === 'win32') {
    // Common Windows install locations
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidatePaths.push(join(localAppData, 'openclaw', 'openclaw.cmd'));
      candidatePaths.push(join(localAppData, 'openclaw', 'openclaw.exe'));
    }
    if (process.env.ProgramFiles) {
      candidatePaths.push(join(process.env.ProgramFiles, 'openclaw', 'openclaw.cmd'));
    }
  }

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      const out = await trySpawn(candidate, ['--version']);
      if (out) {
        version = out.split('\n')[0].trim();
        source = candidate.includes('.local') ? 'managed' : 'system';
        cliInvocable = true;
        foundAt = candidate;
        break;
      }
    }
  }

  if (!cliInvocable) {
    if (!status.packageExists) {
      detail = 'openclaw package missing from app bundle';
    } else if (!status.isBuilt) {
      detail = 'openclaw package not built';
    } else {
      detail = `openclaw CLI not installed (checked ${candidatePaths.length} location(s))`;
    }
    version = undefined;
  } else if (foundAt) {
    detail = `Found at ${foundAt}`;
  }

  return {
    kind: 'openclaw',
    installed: cliInvocable,
    version,
    source,
    required: true,
    estimatedBytes: undefined,
    detail,
    autoInstallable: status.packageExists,
    manualHint: undefined,
  };
}

/**
 * Check uv + Python 3.12 availability. Delegates to existing uv-setup utils.
 */
async function checkPython(): Promise<DepStatus> {
  let version: string | undefined;
  let source: DepStatus['source'] = 'missing';
  let detail: string | undefined;

  try {
    const uvInstalled = await checkUvInstalled();
    if (!uvInstalled) {
      detail = 'uv not found';
      return {
        kind: 'python',
        installed: false,
        version,
        source,
        required: true,
        estimatedBytes: 20 * 1024 * 1024,
        detail,
        autoInstallable: true,
        manualHint: undefined,
      };
    }

    const pythonReady = await isPythonReady();
    if (pythonReady) {
      version = '3.12';
      source = 'managed';
    } else {
      detail = 'Python 3.12 not installed via uv';
    }
  } catch (error) {
    detail = String(error);
  }

  return {
    kind: 'python',
    installed: !!version,
    version,
    source,
    required: true,
    estimatedBytes: 20 * 1024 * 1024,
    detail,
    autoInstallable: true,
    manualHint: undefined,
  };
}

/**
 * Check all dependencies in parallel. Returns a snapshot with allReady flag.
 */
export async function checkAllDependencies(): Promise<DependencySnapshot> {
  logger.info('[dependency] Checking all dependencies...');
  const start = Date.now();

  const [git, node, openclaw, python] = await Promise.all([
    checkGit(),
    checkNode(),
    checkOpenClaw(),
    checkPython(),
  ]);

  const deps = [git, node, openclaw, python];
  const allReady = deps.every((dep) => !dep.required || dep.installed);

  logger.info(`[dependency] Check complete in ${Date.now() - start}ms, allReady=${allReady}`);
  for (const dep of deps) {
    logger.debug(
      `  ${dep.kind}: installed=${dep.installed}, source=${dep.source}, version=${dep.version}`
    );
  }

  return { deps, allReady, checkedAt: Date.now() };
}
