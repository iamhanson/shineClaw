/**
 * Background phase — non-blocking startup work.
 *
 * Runs after the window is shown and dependencies are verified. Each stage
 * executes sequentially but failures are logged, not thrown. This phase
 * contains everything from the original initialize() that doesn't need to
 * block the user from interacting with the window.
 */

import type { BootStage } from './phase-runner';
import { ensureClawXContext, repairClawXOnlyBootstrapFiles } from '../../utils/openclaw-workspace';
import { ensureBuiltinSkillsInstalled, ensurePreinstalledSkillsInstalled } from '../../utils/skill-config';
import { ensureAllBundledPluginsInstalled } from '../../utils/plugin-install';
import {
  autoInstallCliIfNeeded,
  generateCompletionCache,
  installCompletionToProfile,
} from '../../utils/openclaw-cli';
import { syncAllProviderAuthToRuntime } from '../../services/providers/provider-runtime-sync';
import { getSetting } from '../../utils/store';
import { deviceOAuthManager } from '../../utils/device-oauth';
import { browserOAuthManager } from '../../utils/browser-oauth';
import { whatsAppLoginManager } from '../../utils/whatsapp-login';
import { logger } from '../../utils/logger';

export const backgroundStages: BootStage[] = [
  {
    name: 'repair-bootstrap-files',
    run: () => repairClawXOnlyBootstrapFiles(),
  },
  {
    name: 'ensure-builtin-skills',
    run: () => ensureBuiltinSkillsInstalled(),
  },
  {
    name: 'ensure-preinstalled-skills',
    run: () => ensurePreinstalledSkillsInstalled(),
  },
  {
    name: 'ensure-bundled-plugins',
    run: () => ensureAllBundledPluginsInstalled(),
  },
  {
    name: 'wire-gateway-events',
    run: (ctx) => {
      ctx.gatewayManager.on('status', (status: { state: string }) => {
        ctx.hostEventBus.emit('gateway:status', status);
        if (status.state === 'running') {
          void ensureClawXContext().catch((error) => {
            logger.warn('Failed to re-merge ClawX context after gateway reconnect:', error);
          });
        }
      });

      ctx.gatewayManager.on('error', (error) => {
        ctx.hostEventBus.emit('gateway:error', { message: error.message });
      });

      ctx.gatewayManager.on('notification', (notification) => {
        ctx.hostEventBus.emit('gateway:notification', notification);
      });

      ctx.gatewayManager.on('chat:message', (data) => {
        ctx.hostEventBus.emit('gateway:chat-message', data);
      });

      ctx.gatewayManager.on('channel:status', (data) => {
        ctx.hostEventBus.emit('gateway:channel-status', data);
      });

      ctx.gatewayManager.on('exit', (code) => {
        ctx.hostEventBus.emit('gateway:exit', { code });
      });
    },
  },
  {
    name: 'wire-oauth-events',
    run: (ctx) => {
      deviceOAuthManager.on('oauth:code', (payload) => {
        ctx.hostEventBus.emit('oauth:code', payload);
      });
      deviceOAuthManager.on('oauth:start', (payload) => {
        ctx.hostEventBus.emit('oauth:start', payload);
      });
      deviceOAuthManager.on('oauth:success', (payload) => {
        ctx.hostEventBus.emit('oauth:success', { ...payload, success: true });
      });
      deviceOAuthManager.on('oauth:error', (error) => {
        ctx.hostEventBus.emit('oauth:error', error);
      });
      browserOAuthManager.on('oauth:start', (payload) => {
        ctx.hostEventBus.emit('oauth:start', payload);
      });
      browserOAuthManager.on('oauth:code', (payload) => {
        ctx.hostEventBus.emit('oauth:code', payload);
      });
      browserOAuthManager.on('oauth:success', (payload) => {
        ctx.hostEventBus.emit('oauth:success', { ...payload, success: true });
      });
      browserOAuthManager.on('oauth:error', (error) => {
        ctx.hostEventBus.emit('oauth:error', error);
      });
      whatsAppLoginManager.on('qr', (data) => {
        ctx.hostEventBus.emit('channel:whatsapp-qr', data);
      });
      whatsAppLoginManager.on('success', (data) => {
        ctx.hostEventBus.emit('channel:whatsapp-success', data);
      });
      whatsAppLoginManager.on('error', (error) => {
        ctx.hostEventBus.emit('channel:whatsapp-error', error);
      });
    },
  },
  {
    name: 'auto-start-gateway',
    run: async (ctx) => {
      const gatewayAutoStart = await getSetting('gatewayAutoStart');
      if (!gatewayAutoStart) {
        logger.info('Gateway auto-start disabled in settings');
        return;
      }

      try {
        await syncAllProviderAuthToRuntime();
        logger.debug('Auto-starting Gateway...');
        await ctx.gatewayManager.start();
        logger.info('Gateway auto-start succeeded');
      } catch (error) {
        logger.error('Gateway auto-start failed:', error);
        ctx.mainWindow?.webContents.send('gateway:error', String(error));
      }
    },
  },
  {
    name: 'merge-clawx-context',
    run: () => ensureClawXContext(),
  },
  {
    name: 'auto-install-cli',
    run: async (ctx) => {
      await autoInstallCliIfNeeded((installedPath) => {
        ctx.mainWindow?.webContents.send('openclaw:cli-installed', installedPath);
      });
      generateCompletionCache();
      installCompletionToProfile();
    },
  },
];
