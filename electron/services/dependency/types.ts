/**
 * Dependency check & install — re-export shared types for main process use.
 */

export type {
  DepKind,
  DepSource,
  DepStatus,
  DependencySnapshot,
  InstallPhase,
  InstallProgress,
} from '../../../shared/dependency';
