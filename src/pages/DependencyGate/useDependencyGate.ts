import { useEffect } from 'react';
import { useDependencyGateStore } from '@/stores/dependency';

export function useDependencyGate() {
  const init = useDependencyGateStore((s) => s.init);
  const fetchSnapshot = useDependencyGateStore((s) => s.fetchSnapshot);
  const snapshot = useDependencyGateStore((s) => s.snapshot);
  const gateRequired = useDependencyGateStore((s) => s.gateRequired);
  const checking = useDependencyGateStore((s) => s.checking);
  const installing = useDependencyGateStore((s) => s.installing);
  const error = useDependencyGateStore((s) => s.error);
  const progress = useDependencyGateStore((s) => s.progress);
  const installMissing = useDependencyGateStore((s) => s.installMissing);
  const proceed = useDependencyGateStore((s) => s.proceed);

  useEffect(() => {
    const dispose = init();
    void fetchSnapshot();
    return dispose;
  }, [init, fetchSnapshot]);

  return {
    snapshot,
    gateRequired,
    checking,
    installing,
    error,
    progress,
    fetchSnapshot,
    installMissing,
    proceed,
  };
}
