/**
 * Runtime path management for portable dependencies.
 *
 * ClawX downloads portable git/node into ~/.shan/runtime/<kind>/bin/ when the
 * host system is missing them. These directories must be prepended to PATH
 * before any spawn() in the rest of the app, including the gateway child
 * process. The functions here are the single source of truth for those paths.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { delimiter } from 'node:path';
import type { DepKind } from './types';

const RUNTIME_DIR_NAME = '.shan';
const RUNTIME_SUBDIR = 'runtime';

export function getRuntimeRoot(): string {
  return join(homedir(), RUNTIME_DIR_NAME, RUNTIME_SUBDIR);
}

export function getRuntimeDir(kind: DepKind): string {
  return join(getRuntimeRoot(), kind);
}

/**
 * Directory placed onto PATH for a given kind. node and git use a `bin`
 * subdirectory on Unix; on Windows, node lives at the root and git ships a
 * `cmd` directory.
 */
export function getRuntimeBinDir(kind: DepKind): string {
  const root = getRuntimeDir(kind);
  if (process.platform === 'win32') {
    if (kind === 'git') return join(root, 'cmd');
    if (kind === 'node') return root;
    return root;
  }
  return join(root, 'bin');
}

export function ensureRuntimeRoot(): string {
  const root = getRuntimeRoot();
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  return root;
}

/**
 * Prepend known runtime bin dirs to process.env.PATH. Idempotent — calling
 * twice will not duplicate entries. Must be invoked before phase-critical so
 * subsequent spawn() calls inherit the patched PATH.
 */
export function applyRuntimePathToProcess(): void {
  const candidates: string[] = [];
  const kinds: DepKind[] = ['git', 'node'];

  for (const kind of kinds) {
    const binDir = getRuntimeBinDir(kind);
    if (existsSync(binDir)) {
      candidates.push(binDir);
    }
  }

  if (candidates.length === 0) return;

  const pathKey = process.platform === 'win32'
    ? Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path'
    : 'PATH';

  const current = process.env[pathKey] ?? '';
  const existing = new Set(current.split(delimiter));
  const additions = candidates.filter((entry) => !existing.has(entry));
  if (additions.length === 0) return;

  process.env[pathKey] = [...additions, current].filter(Boolean).join(delimiter);
}

/**
 * Returns the absolute path to a managed binary if present, else null.
 * Caller is responsible for verifying executability before use.
 */
export function getManagedBinaryPath(kind: 'git' | 'node'): string | null {
  const binDir = getRuntimeBinDir(kind);
  const exeName = kind === 'node'
    ? (process.platform === 'win32' ? 'node.exe' : 'node')
    : (process.platform === 'win32' ? 'git.exe' : 'git');
  const candidate = join(binDir, exeName);
  return existsSync(candidate) ? candidate : null;
}
