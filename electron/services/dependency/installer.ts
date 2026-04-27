/**
 * Dependency installer — dispatches to per-kind strategies.
 */

import type { DepKind } from './types';
import type { ProgressEmitter } from './progress';
import { installGit } from './strategies/git';
import { installNode } from './strategies/node';
import { installOpenClaw } from './strategies/openclaw';
import { installPython } from './strategies/uv-python';
import { logger } from '../../utils/logger';

export async function installDependency(
  kind: DepKind,
  emitter: ProgressEmitter,
): Promise<void> {
  logger.info(`[dependency] Installing ${kind}...`);
  emitter.update('pending', 0, `Preparing to install ${kind}...`);

  try {
    switch (kind) {
      case 'git':
        await installGit(emitter);
        break;
      case 'node':
        await installNode(emitter);
        break;
      case 'openclaw':
        await installOpenClaw(emitter);
        break;
      case 'python':
        await installPython(emitter);
        break;
      default:
        throw new Error(`Unknown dependency kind: ${kind}`);
    }
    logger.info(`[dependency] ${kind} installed successfully`);
  } catch (error) {
    logger.error(`[dependency] ${kind} install failed:`, error);
    throw error;
  }
}
