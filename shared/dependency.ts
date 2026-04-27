/**
 * Dependency check & install — shared types (cross-process).
 *
 * Used by both the main process (checker/installer/routes) and the renderer
 * (DependencyGate UI + zustand store).
 */

export type DepKind = 'git' | 'node' | 'openclaw' | 'python';

export type DepSource = 'system' | 'bundled' | 'managed' | 'missing';

export type InstallPhase =
  | 'pending'
  | 'downloading'
  | 'extracting'
  | 'installing'
  | 'verifying'
  | 'done'
  | 'error';

export interface DepStatus {
  kind: DepKind;
  installed: boolean;
  version?: string;
  source: DepSource;
  required: boolean;
  estimatedBytes?: number;
  detail?: string;
  autoInstallable: boolean;
  manualHint?: string;
}

export interface InstallProgress {
  kind: DepKind;
  phase: InstallPhase;
  percent: number;
  message: string;
  bytesDownloaded?: number;
  bytesTotal?: number;
  error?: string;
}

export interface DependencySnapshot {
  deps: DepStatus[];
  allReady: boolean;
  checkedAt: number;
}
