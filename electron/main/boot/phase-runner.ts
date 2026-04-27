/**
 * Boot phase types & runner.
 *
 * Splits app initialization into three sequential phases:
 *   - critical:    blocks window display (logger, proxy, window, IPC, HostAPI)
 *   - health:      dependency check; may block on user install via gate UI
 *   - background:  fire-and-forget (skills, plugins, gateway autostart, CLI)
 *
 * Only the critical phase throws on failure. Health phase emits a gate-required
 * event and awaits user resolution. Background phase logs but never throws.
 */

import type { BrowserWindow } from 'electron';
import type { Server } from 'node:http';
import type { GatewayManager } from '../../gateway/manager';
import type { ClawHubService } from '../../gateway/clawhub';
import type { HostEventBus } from '../../api/event-bus';
import { logger } from '../../utils/logger';

export type BootPhase = 'critical' | 'health' | 'background';

export interface BootContext {
  mainWindow: BrowserWindow;
  gatewayManager: GatewayManager;
  clawHubService: ClawHubService;
  hostEventBus: HostEventBus;
  hostApiServer: Server | null;
  setFloatingBallEnabled: (enabled: boolean) => void;
  floatingBallWindow: () => BrowserWindow | null;
}

export interface BootStage {
  name: string;
  run: (ctx: BootContext) => Promise<void> | void;
  /** When true, errors are rethrown; otherwise just logged. */
  blocking?: boolean;
}

export async function runStages(
  phase: BootPhase,
  stages: BootStage[],
  ctx: BootContext,
): Promise<void> {
  const phaseStart = Date.now();
  logger.info(`[boot] phase=${phase} starting (${stages.length} stages)`);

  for (const stage of stages) {
    const stageStart = Date.now();
    try {
      await stage.run(ctx);
      logger.debug(`[boot] phase=${phase} stage=${stage.name} done in ${Date.now() - stageStart}ms`);
    } catch (error) {
      const elapsed = Date.now() - stageStart;
      if (stage.blocking) {
        logger.error(`[boot] phase=${phase} stage=${stage.name} FAILED in ${elapsed}ms (blocking):`, error);
        throw error;
      }
      logger.warn(`[boot] phase=${phase} stage=${stage.name} failed in ${elapsed}ms (non-blocking):`, error);
    }
  }

  logger.info(`[boot] phase=${phase} complete in ${Date.now() - phaseStart}ms`);
}
