/**
 * Progress emitter — bridges install strategies to the host event bus.
 *
 * Each strategy calls `emit()` with incremental progress updates. The emitter
 * normalises them and forwards to the HostEventBus as `dep:progress` SSE events.
 */

import type { DepKind, InstallPhase, InstallProgress } from './types';

export type ProgressSink = (progress: InstallProgress) => void;

export function createProgressEmitter(kind: DepKind, sink: ProgressSink) {
  let lastPercent = 0;

  return {
    update(phase: InstallPhase, percent: number, message: string, extra?: Partial<InstallProgress>) {
      lastPercent = Math.max(lastPercent, Math.min(100, percent));
      sink({ kind, phase, percent: lastPercent, message, ...extra });
    },
    done(message = 'Done') {
      sink({ kind, phase: 'done', percent: 100, message });
    },
    error(error: string) {
      sink({ kind, phase: 'error', percent: lastPercent, message: error, error });
    },
  };
}

export type ProgressEmitter = ReturnType<typeof createProgressEmitter>;
