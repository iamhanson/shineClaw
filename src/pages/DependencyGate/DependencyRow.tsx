import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Download,
  Package,
  Search,
  Wrench,
} from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { DepStatus, InstallProgress, InstallPhase } from '../../../shared/dependency';

interface DependencyRowProps {
  dep: DepStatus;
  progress?: InstallProgress;
}

const PHASE_LABELS: Record<InstallPhase, string> = {
  pending: '等待中...',
  downloading: '下载中...',
  extracting: '解压中...',
  installing: '安装中...',
  verifying: '验证中...',
  done: '完成',
  error: '失败',
};

function PhaseIcon({ phase }: { phase: InstallPhase }) {
  switch (phase) {
    case 'downloading':
      return <Download className="h-3.5 w-3.5 animate-pulse" />;
    case 'extracting':
      return <Package className="h-3.5 w-3.5 animate-pulse" />;
    case 'verifying':
      return <Search className="h-3.5 w-3.5 animate-pulse" />;
    case 'installing':
      return <Wrench className="h-3.5 w-3.5 animate-pulse" />;
    default:
      return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DependencyRow({ dep, progress }: DependencyRowProps) {
  const isDone = dep.installed || progress?.phase === 'done';
  const isWorking = progress && progress.phase !== 'done' && progress.phase !== 'error';
  const isError = progress?.phase === 'error';

  return (
    <div
      className={cn(
        'rounded-xl border p-4 backdrop-blur-sm transition-all duration-300',
        isDone
          ? 'border-emerald-500/20 bg-emerald-500/[0.03]'
          : isWorking
            ? 'border-blue-500/30 bg-blue-500/[0.03]'
            : isError
              ? 'border-red-500/30 bg-red-500/[0.03]'
              : 'border-border/60 bg-card/70'
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {isDone ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          ) : isWorking ? (
            <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
          ) : (
            <AlertCircle className={cn('h-5 w-5', isError ? 'text-red-500' : 'text-amber-500')} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium capitalize">
                {dep.kind === 'python' ? 'Python 3.12' : dep.kind}
              </p>
              <p className="text-sm text-muted-foreground">
                {isDone
                  ? `已安装${dep.version ? ` · ${dep.version}` : ''} · ${dep.source}`
                  : isError
                    ? progress?.error || '安装失败'
                    : isWorking
                      ? progress?.message
                      : dep.detail || '未安装'}
              </p>
            </div>
            {isDone && dep.version ? (
              <span className="shrink-0 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-mono text-emerald-700 dark:text-emerald-400">
                v{dep.version}
              </span>
            ) : (
              <div className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                {dep.required ? '必需' : '可选'}
              </div>
            )}
          </div>

          {isWorking && progress ? (
            <div className="mt-3 space-y-2">
              <Progress value={progress.percent} className="h-2" />
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
                  <PhaseIcon phase={progress.phase} />
                  <span>{PHASE_LABELS[progress.phase] || progress.phase}</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  {progress.bytesDownloaded && progress.bytesTotal ? (
                    <span>
                      {formatBytes(progress.bytesDownloaded)} / {formatBytes(progress.bytesTotal)}
                    </span>
                  ) : null}
                  <span className="font-mono">{progress.percent}%</span>
                </div>
              </div>
            </div>
          ) : null}

          {isError && progress?.error ? (
            <p className="mt-2 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400">
              {progress.error}
            </p>
          ) : null}

          {!isDone && !isWorking && !isError && dep.manualHint ? (
            <p className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
              {dep.manualHint}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
