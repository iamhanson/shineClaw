/**
 * OpenClaw install strategy — wraps existing installOpenClawCli() for packaged
 * builds, and creates a symlink from ~/.local/bin/openclaw to the project's
 * node_modules/.bin/openclaw in dev mode.
 */

import { app } from 'electron';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProgressEmitter } from '../progress';
import { installOpenClawCli } from '../../../utils/openclaw-cli';
import { getOpenClawStatus, getOpenClawEntryPath } from '../../../utils/paths';
import { logger } from '../../../utils/logger';

export async function installOpenClaw(emitter: ProgressEmitter): Promise<void> {
  emitter.update('verifying', 10, '检查 OpenClaw 包...');

  const status = getOpenClawStatus();
  if (!status.packageExists) {
    emitter.error('OpenClaw package missing from app bundle. Please reinstall the app.');
    throw new Error('OpenClaw package missing');
  }
  if (!status.isBuilt) {
    emitter.error('OpenClaw package is not built. Please reinstall the app.');
    throw new Error('OpenClaw package not built');
  }

  emitter.update('installing', 40, '安装 OpenClaw CLI...');

  if (app.isPackaged) {
    const result = await installOpenClawCli();
    if (result.success) {
      emitter.done(`OpenClaw CLI installed at ${result.path}`);
    } else {
      emitter.error(result.error || 'Unknown error');
      throw new Error(result.error || 'OpenClaw CLI install failed');
    }
  } else {
    // Dev mode: create symlink manually
    await installOpenClawDev(emitter);
  }
}

async function installOpenClawDev(emitter: ProgressEmitter): Promise<void> {
  const platform = process.platform;
  if (platform === 'win32') {
    emitter.error('Dev mode CLI install not supported on Windows. Use packaged build.');
    throw new Error('Dev mode CLI install not supported on Windows');
  }

  const targetDir = join(homedir(), '.local', 'bin');
  const targetPath = join(targetDir, 'openclaw');
  const entryPath = getOpenClawEntryPath();

  if (!existsSync(entryPath)) {
    emitter.error(`OpenClaw entry not found at ${entryPath}`);
    throw new Error(`OpenClaw entry not found at ${entryPath}`);
  }

  emitter.update('installing', 60, '创建 CLI 符号链接...');

  try {
    mkdirSync(targetDir, { recursive: true });

    if (existsSync(targetPath)) {
      unlinkSync(targetPath);
    }

    // Create a wrapper script that invokes node with the entry path
    const wrapperContent = `#!/bin/sh\nexec node "${entryPath}" "$@"\n`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(targetPath, wrapperContent, { mode: 0o755 });

    logger.info(`[openclaw-install] Dev CLI wrapper created at ${targetPath}`);
    emitter.update('verifying', 90, '验证安装...');

    if (existsSync(targetPath)) {
      emitter.done(`OpenClaw CLI installed at ${targetPath}`);
    } else {
      emitter.error('CLI wrapper creation failed');
      throw new Error('CLI wrapper not found after creation');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emitter.error(msg);
    throw error;
  }
}
