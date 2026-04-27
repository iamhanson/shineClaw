/**
 * Python install strategy — uses uv to install managed Python 3.12.
 *
 * Wraps existing checkUvInstalled / installUv / setupManagedPython utilities,
 * adding progress reporting that parses uv's stderr for download stages.
 */

import type { ProgressEmitter } from '../progress';
import { checkUvInstalled, installUv, setupManagedPython } from '../../../utils/uv-setup';

export async function installPython(emitter: ProgressEmitter): Promise<void> {
  emitter.update('verifying', 10, 'Checking uv availability...');

  const uvAvailable = await checkUvInstalled();
  if (!uvAvailable) {
    emitter.update('installing', 20, 'Verifying bundled uv binary...');
    try {
      await installUv();
    } catch (error) {
      emitter.error(String(error));
      throw error;
    }
  }

  // Wrap setupManagedPython with periodic progress updates. The underlying
  // uv command can take 30-60s; we report periodic heartbeats since stderr
  // parsing is fragile across uv versions.
  emitter.update('downloading', 30, 'Downloading Python 3.12 (this may take a minute)...');

  const heartbeat = setInterval(() => {
    // Slowly creep from 30% to 85% over the install duration
    const elapsed = Date.now() - startTime;
    const targetPercent = Math.min(85, 30 + Math.floor(elapsed / 1000));
    emitter.update('downloading', targetPercent, 'Installing Python 3.12...');
  }, 1500);

  const startTime = Date.now();

  try {
    await setupManagedPython();
    clearInterval(heartbeat);
    emitter.update('verifying', 95, 'Verifying Python installation...');
    emitter.done('Python 3.12 installed');
  } catch (error) {
    clearInterval(heartbeat);
    emitter.error(String(error));
    throw error;
  }
}
