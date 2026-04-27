/**
 * Health phase — dependency check & gate.
 *
 * Probes git/node/openclaw/python. If any required dep is missing, sends a
 * `boot:gate-required` event to the renderer (which navigates to /dependency-gate)
 * and awaits a `proceed` POST from the renderer before returning.
 */

import type { BootStage } from './phase-runner';
import { applyRuntimePathToProcess } from '../../services/dependency/runtime-paths';
import { checkAllDependencies } from '../../services/dependency/checker';
import { setProceedResolver } from '../../api/routes/system';
import { logger } from '../../utils/logger';

export const healthStages: BootStage[] = [
  {
    name: 'apply-runtime-path',
    run: () => {
      applyRuntimePathToProcess();
    },
  },
  {
    name: 'check-dependencies',
    blocking: true,
    run: async (ctx) => {
      const snapshot = await checkAllDependencies();

      if (snapshot.allReady) {
        logger.info('[boot] All dependencies ready');
        return;
      }

      const missing = snapshot.deps.filter((d) => d.required && !d.installed);
      logger.warn(`[boot] Missing dependencies: ${missing.map((d) => d.kind).join(', ')}`);

      // Notify renderer to navigate to gate
      ctx.hostEventBus.emit('boot:gate-required', { deps: snapshot.deps });
      ctx.mainWindow.webContents.send('boot:gate-required', { deps: snapshot.deps });

      // Wait for renderer to confirm all deps are ready
      await new Promise<void>((resolve) => {
        setProceedResolver(resolve);
        logger.info('[boot] Waiting for user to install dependencies...');
      });

      // Re-verify after user confirms
      applyRuntimePathToProcess();
      const finalSnapshot = await checkAllDependencies();
      if (!finalSnapshot.allReady) {
        logger.warn('[boot] Proceed received but some deps still missing; continuing anyway');
      } else {
        logger.info('[boot] All dependencies confirmed ready');
      }
    },
  },
];
