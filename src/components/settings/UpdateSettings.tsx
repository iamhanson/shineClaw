/**
 * Update Settings Component
 * Displays update status and allows manual update checking/installation
 */
import { useEffect, useCallback } from 'react';
import { Download, RefreshCw, Loader2, Rocket, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useUpdateStore } from '@/stores/update';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function UpdateSettings() {
  const { t } = useTranslation('settings');
  const {
    status,
    currentVersion,
    updateInfo,
    progress,
    error,
    isInitialized,
    autoInstallCountdown,
    init,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    cancelAutoInstall,
    clearError,
  } = useUpdateStore();

  // Initialize on mount
  useEffect(() => {
    init();
  }, [init]);

  const handleCheckForUpdates = useCallback(async () => {
    clearError();
    await checkForUpdates();
  }, [checkForUpdates, clearError]);

  const normalizeUpdateError = useCallback(
    (raw: string | null | undefined): string | null => {
      if (!raw) return null;
      if (
        raw === 'UPDATE_CHECK_SKIPPED_DEV_MODE'
        || raw === 'UPDATE_CHECK_NO_RESULT_DEV_MODE'
        || raw.includes('app is not packaged')
      ) {
        return t('updates.status.devModeSkipped');
      }
      return raw;
    },
    [t]
  );

  const renderStatusIcon = () => {
    switch (status) {
      case 'checking':
      case 'downloading':
        return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
      case 'available':
        return <Download className="h-4 w-4 text-primary" />;
      case 'downloaded':
        return <Rocket className="h-4 w-4 text-primary" />;
      case 'error':
        return <RefreshCw className="h-4 w-4 text-destructive" />;
      default:
        return <RefreshCw className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const renderStatusText = () => {
    if (status === 'downloaded' && autoInstallCountdown != null && autoInstallCountdown >= 0) {
      return t('updates.status.autoInstalling', { seconds: autoInstallCountdown });
    }
    switch (status) {
      case 'checking':
        return t('updates.status.checking');
      case 'downloading':
        return t('updates.status.downloading');
      case 'available':
        return t('updates.status.available', { version: updateInfo?.version });
      case 'downloaded':
        return t('updates.status.downloaded', { version: updateInfo?.version });
      case 'error':
        return normalizeUpdateError(error) || t('updates.status.failed');
      case 'not-available':
        return t('updates.status.latest');
      default:
        return t('updates.status.check');
    }
  };

  const renderAction = () => {
    switch (status) {
      case 'checking':
        return (
          <Button disabled variant="outline" size="sm">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            {t('updates.action.checking')}
          </Button>
        );
      case 'downloading':
        return (
          <Button disabled variant="outline" size="sm">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            {t('updates.action.downloading')}
          </Button>
        );
      case 'available':
        return (
          <Button onClick={downloadUpdate} size="sm">
            <Download className="h-4 w-4 mr-2" />
            {t('updates.action.download')}
          </Button>
        );
      case 'downloaded':
        if (autoInstallCountdown != null && autoInstallCountdown >= 0) {
          return (
            <Button onClick={cancelAutoInstall} size="sm" variant="outline">
              <XCircle className="h-4 w-4 mr-2" />
              {t('updates.action.cancelAutoInstall')}
            </Button>
          );
        }
        return (
          <Button onClick={installUpdate} size="sm" variant="default">
            <Rocket className="h-4 w-4 mr-2" />
            {t('updates.action.install')}
          </Button>
        );
      case 'error':
        return (
          <Button onClick={handleCheckForUpdates} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('updates.action.retry')}
          </Button>
        );
      default:
        return (
          <Button onClick={handleCheckForUpdates} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('updates.action.check')}
          </Button>
        );
    }
  };

  if (!isInitialized) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t('common:status.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              status === 'error' && 'text-destructive',
              (status === 'available' || status === 'downloaded') && 'text-primary',
              status !== 'error' &&
                status !== 'available' &&
                status !== 'downloaded' &&
                'text-muted-foreground'
            )}
          >
            {renderStatusIcon()}
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-foreground">v{currentVersion}</p>
            <p className="text-[12px] text-muted-foreground truncate">{renderStatusText()}</p>
          </div>
        </div>
        <div className="shrink-0">{renderAction()}</div>
      </div>

      {status === 'downloading' && progress && (
        <div className="space-y-2 pt-1">
          <div className="flex justify-between text-[12px] text-muted-foreground">
            <span>
              {formatBytes(progress.transferred)} / {formatBytes(progress.total)}
            </span>
            <span>{formatBytes(progress.bytesPerSecond)}/s</span>
          </div>
          <Progress value={progress.percent} className="h-1.5" />
        </div>
      )}

      {updateInfo && (status === 'available' || status === 'downloaded') && (
        <div className="space-y-1 pt-1">
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-medium text-foreground">
              {t('updates.versionLabel', { version: updateInfo.version })}
            </p>
            {updateInfo.releaseDate && (
              <p className="text-[12px] text-muted-foreground">
                {new Date(updateInfo.releaseDate).toLocaleDateString()}
              </p>
            )}
          </div>
          {updateInfo.releaseNotes && (
            <p className="text-[12px] text-muted-foreground whitespace-pre-wrap">
              {updateInfo.releaseNotes}
            </p>
          )}
        </div>
      )}

      {status === 'error' && error && (
        <p className="text-[12px] text-destructive">{normalizeUpdateError(error)}</p>
      )}
    </div>
  );
}

export default UpdateSettings;
