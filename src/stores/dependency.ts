/**
 * Dependency Gate state store.
 *
 * Tracks whether the app is currently blocked on missing dependencies and keeps
 * the latest snapshot/progress events coming from the main process.
 */

import { create } from 'zustand';
import type { DependencySnapshot, DepStatus, InstallProgress } from '../../shared/dependency';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';

interface DependencyGateState {
  gateRequired: boolean;
  checking: boolean;
  installing: boolean;
  error?: string;
  snapshot?: DependencySnapshot;
  progress: Record<string, InstallProgress>;
  init: () => () => void;
  fetchSnapshot: () => Promise<void>;
  installMissing: () => Promise<void>;
  proceed: () => Promise<void>;
}

export const useDependencyGateStore = create<DependencyGateState>((set, get) => ({
  gateRequired: false,
  checking: false,
  installing: false,
  snapshot: undefined,
  progress: {},

  init: () => {
    const offGate = subscribeHostEvent<{ deps: DependencySnapshot['deps'] }>(
      'boot:gate-required',
      (payload) => {
        set({
          gateRequired: true,
          snapshot: {
            deps: payload.deps,
            allReady: payload.deps.every((d: DepStatus) => !d.required || d.installed),
            checkedAt: Date.now(),
          },
        });
      }
    );

    const offProgress = subscribeHostEvent<InstallProgress>('dep:progress', (progress) => {
      set((state) => ({
        progress: { ...state.progress, [progress.kind]: progress },
        installing: progress.phase !== 'done' && progress.phase !== 'error',
      }));
    });

    const offSnapshot = subscribeHostEvent<DependencySnapshot>('dep:snapshot', (snapshot) => {
      set({ snapshot, checking: false, installing: false, gateRequired: !snapshot.allReady });
    });

    const offStatus = subscribeHostEvent<DepStatus>('dep:status-changed', (dep) => {
      set((state) => {
        const current = state.snapshot;
        if (!current) return state;
        const deps = current.deps.map((d: DepStatus) => (d.kind === dep.kind ? dep : d));
        return {
          snapshot: {
            deps,
            allReady: deps.every((d: DepStatus) => !d.required || d.installed),
            checkedAt: Date.now(),
          },
        };
      });
    });

    return () => {
      offGate();
      offProgress();
      offSnapshot();
      offStatus();
    };
  },

  fetchSnapshot: async () => {
    set({ checking: true, error: undefined });
    try {
      const snapshot = await hostApiFetch<DependencySnapshot>('/api/system/dependencies');
      set({ snapshot, checking: false, gateRequired: !snapshot.allReady });
    } catch (error) {
      set({ checking: false, error: String(error) });
    }
  },

  installMissing: async () => {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const missing = snapshot.deps.filter((d: DepStatus) => d.required && !d.installed);
    if (missing.length === 0) return;

    set({ installing: true, error: undefined });
    try {
      await hostApiFetch('/api/system/dependencies/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kinds: missing.map((d: DepStatus) => d.kind) }),
      });
    } catch (error) {
      set({ installing: false, error: String(error) });
    }
  },

  proceed: async () => {
    await hostApiFetch('/api/system/dependencies/proceed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    set({ gateRequired: false });
  },
}));
