import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Download, CheckCircle2, Sparkles, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { TitleBar } from '@/components/layout/TitleBar';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings';
import type { DepStatus } from '../../../shared/dependency';
import { DependencyRow } from './DependencyRow';
import { useDependencyGate } from './useDependencyGate';

export function DependencyGate() {
  const { t } = useTranslation('dependency');
  const navigate = useNavigate();
  const setupComplete = useSettingsStore((s) => s.setupComplete);
  const {
    snapshot,
    checking,
    installing,
    error,
    progress,
    fetchSnapshot,
    installMissing,
    proceed,
  } = useDependencyGate();

  const [showSuccess, setShowSuccess] = useState(false);

  const missingCount = useMemo(() => {
    return snapshot?.deps.filter((d: DepStatus) => d.required && !d.installed).length ?? 0;
  }, [snapshot]);

  // When all ready: first-time → show success with model config CTA; returning user → auto-proceed
  useEffect(() => {
    if (snapshot?.allReady && !installing && !checking) {
      if (setupComplete) {
        // Returning user, deps OK → go straight to main
        void proceed().then(() => navigate('/'));
      } else {
        // First launch → show success screen with model config button
        setShowSuccess(true);
      }
    }
  }, [snapshot?.allReady, installing, checking, setupComplete, proceed, navigate]);

  const handleProceed = async () => {
    await proceed();
    navigate(setupComplete ? '/' : '/setup');
  };

  return (
    <div className="flex h-screen w-full flex-col bg-background">
      <TitleBar />
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
        <div className="w-full max-w-2xl space-y-6">
          <AnimatePresence mode="wait">
            {showSuccess ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
                className="space-y-6"
              >
                <div className="flex flex-col items-center space-y-4 py-8">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
                    <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                  </div>
                  <div className="space-y-2 text-center">
                    <h1 className="text-2xl font-semibold">{t('success.title')}</h1>
                    <p className="text-muted-foreground">{t('success.description')}</p>
                  </div>
                </div>

                <div className="flex flex-col items-center gap-3">
                  <Button
                    size="lg"
                    onClick={() => void handleProceed()}
                    className="gap-2 rounded-xl px-8"
                  >
                    <Sparkles className="h-4 w-4" />
                    {t('success.configureModel')}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                  {setupComplete ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleProceed()}
                      className="text-muted-foreground"
                    >
                      {t('success.skipToMain')}
                    </Button>
                  ) : null}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="checking"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-6"
              >
                <div className="space-y-2 text-center">
                  <h1 className="text-2xl font-semibold">{t('title')}</h1>
                  <p className="text-muted-foreground">{t('description')}</p>
                </div>

                {error ? (
                  <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600">
                    {error}
                  </div>
                ) : null}

                <div className="space-y-3">
                  {checking && !snapshot ? (
                    <div className="flex items-center justify-center py-12 text-muted-foreground">
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      {t('checking')}
                    </div>
                  ) : (
                    snapshot?.deps.map((dep: DepStatus) => (
                      <DependencyRow key={dep.kind} dep={dep} progress={progress[dep.kind]} />
                    ))
                  )}
                </div>

                <div className="flex items-center justify-center gap-3 pt-2">
                  <Button
                    variant="outline"
                    onClick={fetchSnapshot}
                    disabled={checking || installing}
                  >
                    <RefreshCw className={`mr-2 h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
                    {t('actions.recheck')}
                  </Button>
                  <Button onClick={installMissing} disabled={installing || missingCount === 0}>
                    {installing ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="mr-2 h-4 w-4" />
                    )}
                    {t('actions.installMissing', { count: missingCount })}
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export default DependencyGate;
