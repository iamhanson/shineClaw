/**
 * System routes — dependency check, install, and proceed endpoints.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { sendJson, parseJsonBody } from '../route-utils';
import { checkAllDependencies } from '../../services/dependency/checker';
import { installDependency } from '../../services/dependency/installer';
import { createProgressEmitter } from '../../services/dependency/progress';
import { applyRuntimePathToProcess } from '../../services/dependency/runtime-paths';
import type { DepKind, InstallProgress } from '../../services/dependency/types';
import { logger } from '../../utils/logger';

let proceedResolve: (() => void) | null = null;

/**
 * Register the proceed resolver so phase-health can await it.
 */
export function setProceedResolver(resolve: () => void): void {
  proceedResolve = resolve;
}

export async function handleSystemRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext
): Promise<boolean> {
  // GET /api/system/dependencies — return current status
  if (url.pathname === '/api/system/dependencies' && req.method === 'GET') {
    const snapshot = await checkAllDependencies();
    sendJson(res, 200, snapshot);
    return true;
  }

  // POST /api/system/dependencies/recheck — force re-probe
  if (url.pathname === '/api/system/dependencies/recheck' && req.method === 'POST') {
    applyRuntimePathToProcess();
    const snapshot = await checkAllDependencies();
    sendJson(res, 200, snapshot);
    return true;
  }

  // POST /api/system/dependencies/install — install missing deps
  if (url.pathname === '/api/system/dependencies/install' && req.method === 'POST') {
    const body = await parseJsonBody<{ kinds?: DepKind[] }>(req);
    const kinds = body.kinds ?? [];

    if (kinds.length === 0) {
      sendJson(res, 400, { success: false, error: 'No dependencies specified' });
      return true;
    }

    const installId = `install-${Date.now()}`;
    sendJson(res, 202, { success: true, installId });

    // Run installs sequentially in background, pushing progress via SSE + IPC
    void (async () => {
      for (const kind of kinds) {
        const emitter = createProgressEmitter(kind, (progress: InstallProgress) => {
          ctx.eventBus.emit('dep:progress', progress);
          ctx.mainWindow?.webContents.send('dep:progress', progress);
        });

        try {
          await installDependency(kind, emitter);
        } catch (error) {
          logger.error(`[system-routes] Install ${kind} failed:`, error);
        }

        // Re-check this dep and push updated status
        applyRuntimePathToProcess();
        const snapshot = await checkAllDependencies();
        const depStatus = snapshot.deps.find((d) => d.kind === kind);
        if (depStatus) {
          ctx.eventBus.emit('dep:status-changed', depStatus);
          ctx.mainWindow?.webContents.send('dep:status-changed', depStatus);
        }
      }

      // Final recheck
      applyRuntimePathToProcess();
      const finalSnapshot = await checkAllDependencies();
      ctx.eventBus.emit('dep:snapshot', finalSnapshot);
      ctx.mainWindow?.webContents.send('dep:snapshot', finalSnapshot);
    })();

    return true;
  }

  // POST /api/system/dependencies/proceed — unblock health phase
  if (url.pathname === '/api/system/dependencies/proceed' && req.method === 'POST') {
    if (proceedResolve) {
      proceedResolve();
      proceedResolve = null;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
