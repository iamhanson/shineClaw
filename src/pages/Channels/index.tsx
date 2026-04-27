import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, Trash2, AlertCircle, Plus, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useGatewayStore } from '@/stores/gateway';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import { ChannelConfigModal } from '@/components/channels/ChannelConfigModal';
import { cn } from '@/lib/utils';
import {
  CHANNEL_ICONS,
  CHANNEL_NAMES,
  CHANNEL_META,
  getPrimaryChannels,
  type ChannelType,
} from '@/types/channel';
import { usesPluginManagedQrAccounts } from '@/lib/channel-alias';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import telegramIcon from '@/assets/channels/telegram.svg';
import discordIcon from '@/assets/channels/discord.svg';
import whatsappIcon from '@/assets/channels/whatsapp.svg';
import wechatIcon from '@/assets/channels/wechat.svg';
import dingtalkIcon from '@/assets/channels/dingtalk.svg';
import feishuIcon from '@/assets/channels/feishu.svg';
import wecomIcon from '@/assets/channels/wecom.svg';
import qqIcon from '@/assets/channels/qq.svg';

interface ChannelAccountItem {
  accountId: string;
  name: string;
  configured: boolean;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  lastError?: string;
  isDefault: boolean;
  agentId?: string;
}

interface ChannelGroupItem {
  channelType: string;
  defaultAccountId: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  accounts: ChannelAccountItem[];
}

interface AgentItem {
  id: string;
  name: string;
}

interface PairingRequestItem {
  id: string;
  userId: string;
  code: string;
  createdAt: string;
  lastSeenAt?: string;
  accountId?: string;
  meta?: Record<string, string>;
}

interface DeleteTarget {
  channelType: string;
  accountId?: string;
}

function removeDeletedTarget(groups: ChannelGroupItem[], target: DeleteTarget): ChannelGroupItem[] {
  if (target.accountId) {
    return groups
      .map((group) => {
        if (group.channelType !== target.channelType) return group;
        return {
          ...group,
          accounts: group.accounts.filter((account) => account.accountId !== target.accountId),
        };
      })
      .filter((group) => group.accounts.length > 0);
  }

  return groups.filter((group) => group.channelType !== target.channelType);
}

export function Channels() {
  const { t } = useTranslation('channels');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const lastGatewayStateRef = useRef(gatewayStatus.state);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channelGroups, setChannelGroups] = useState<ChannelGroupItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [selectedChannelType, setSelectedChannelType] = useState<ChannelType | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(undefined);
  const [allowExistingConfigInModal, setAllowExistingConfigInModal] = useState(true);
  const [allowEditAccountIdInModal, setAllowEditAccountIdInModal] = useState(false);
  const [existingAccountIdsForModal, setExistingAccountIdsForModal] = useState<string[]>([]);
  const [initialConfigValuesForModal, setInitialConfigValuesForModal] = useState<
    Record<string, string> | undefined
  >(undefined);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [pairingModalOpen, setPairingModalOpen] = useState(false);
  const [pairingModalChannelType, setPairingModalChannelType] = useState<string>('');
  const [pairingModalAccountId, setPairingModalAccountId] = useState<string>('');
  const [pairingRequests, setPairingRequests] = useState<PairingRequestItem[]>([]);
  const [pairingRequestsLoading, setPairingRequestsLoading] = useState(false);
  const [pairingRequestsError, setPairingRequestsError] = useState<string | null>(null);
  const hasLoadedOnceRef = useRef(false);

  const displayedChannelTypes = getPrimaryChannels();

  const fetchPageData = useCallback(async (options?: { force?: boolean }) => {
    if (!hasLoadedOnceRef.current) {
      setLoading(true);
    }
    setError(null);
    try {
      const [channelsRes, agentsRes] = await Promise.all([
        hostApiFetch<{ success: boolean; channels?: ChannelGroupItem[]; error?: string }>(
          `/api/channels/accounts?probe=0${options?.force ? '&force=1' : ''}`
        ),
        hostApiFetch<{ success: boolean; agents?: AgentItem[]; error?: string }>('/api/agents'),
      ]);

      if (!channelsRes.success) {
        throw new Error(channelsRes.error || 'Failed to load channels');
      }

      if (!agentsRes.success) {
        throw new Error(agentsRes.error || 'Failed to load agents');
      }

      setChannelGroups(channelsRes.channels || []);
      setAgents(agentsRes.agents || []);
      hasLoadedOnceRef.current = true;
    } catch (fetchError) {
      setError(String(fetchError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPageData();
  }, [fetchPageData]);

  useEffect(() => {
    const unsubscribe = subscribeHostEvent('gateway:channel-status', () => {
      void fetchPageData();
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [fetchPageData]);

  useEffect(() => {
    const previousGatewayState = lastGatewayStateRef.current;
    lastGatewayStateRef.current = gatewayStatus.state;

    if (previousGatewayState !== 'running' && gatewayStatus.state === 'running') {
      void fetchPageData();
    }
  }, [fetchPageData, gatewayStatus.state]);

  const configuredTypes = useMemo(
    () => channelGroups.map((group) => group.channelType),
    [channelGroups]
  );

  const groupedByType = useMemo(() => {
    return Object.fromEntries(channelGroups.map((group) => [group.channelType, group]));
  }, [channelGroups]);

  const configuredGroups = useMemo(() => {
    const known = displayedChannelTypes
      .map((type) => groupedByType[type])
      .filter((group): group is ChannelGroupItem => Boolean(group));
    const unknown = channelGroups.filter(
      (group) => !displayedChannelTypes.includes(group.channelType as ChannelType)
    );
    return [...known, ...unknown];
  }, [channelGroups, displayedChannelTypes, groupedByType]);

  const unsupportedGroups = displayedChannelTypes.filter((type) => !configuredTypes.includes(type));

  const handleRefresh = () => {
    void fetchPageData({ force: true });
  };

  const handleBindAgent = async (channelType: string, accountId: string, agentId: string) => {
    try {
      if (!agentId) {
        await hostApiFetch<{ success: boolean; error?: string }>('/api/channels/binding', {
          method: 'DELETE',
          body: JSON.stringify({ channelType, accountId }),
        });
      } else {
        await hostApiFetch<{ success: boolean; error?: string }>('/api/channels/binding', {
          method: 'PUT',
          body: JSON.stringify({ channelType, accountId, agentId }),
        });
      }
      await fetchPageData();
      toast.success(t('toast.bindingUpdated'));
    } catch (bindError) {
      toast.error(t('toast.configFailed', { error: String(bindError) }));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const suffix = deleteTarget.accountId
        ? `?accountId=${encodeURIComponent(deleteTarget.accountId)}`
        : '';
      await hostApiFetch(
        `/api/channels/config/${encodeURIComponent(deleteTarget.channelType)}${suffix}`,
        {
          method: 'DELETE',
        }
      );
      setChannelGroups((prev) => removeDeletedTarget(prev, deleteTarget));
      toast.success(deleteTarget.accountId ? t('toast.accountDeleted') : t('toast.channelDeleted'));
      // Channel reload is debounced in main process; pull again shortly to
      // converge with runtime state without flashing deleted rows back in.
      window.setTimeout(() => {
        void fetchPageData();
      }, 1200);
    } catch (deleteError) {
      toast.error(t('toast.configFailed', { error: String(deleteError) }));
    } finally {
      setDeleteTarget(null);
    }
  };

  const createNewAccountId = (channelType: string, existingAccounts: string[]): string => {
    // Generate a collision-safe default account id for user editing.
    let nextAccountId = `${channelType}-${crypto.randomUUID().slice(0, 8)}`;
    while (existingAccounts.includes(nextAccountId)) {
      nextAccountId = `${channelType}-${crypto.randomUUID().slice(0, 8)}`;
    }
    return nextAccountId;
  };

  const loadPairingRequests = useCallback(async (channelType: string, accountId: string) => {
    setPairingRequestsLoading(true);
    setPairingRequestsError(null);
    try {
      const query = new URLSearchParams({
        channelType,
        accountId,
        limit: '100',
      });
      const response = await hostApiFetch<{
        success?: boolean;
        error?: string;
        requests?: PairingRequestItem[];
      }>(`/api/channels/pairing-requests?${query.toString()}`);
      if (!response.success) {
        throw new Error(response.error || 'Failed to load pairing requests');
      }
      setPairingRequests(response.requests || []);
    } catch (requestError) {
      setPairingRequests([]);
      setPairingRequestsError(String(requestError));
    } finally {
      setPairingRequestsLoading(false);
    }
  }, []);

  const openPairingRequestsModal = useCallback((channelType: string, accountId: string) => {
    setPairingModalOpen(true);
    setPairingModalChannelType(channelType);
    setPairingModalAccountId(accountId);
    void loadPairingRequests(channelType, accountId);
  }, [loadPairingRequests]);

  if (loading) {
    return (
      <div className="flex flex-col -m-6 min-h-[calc(100vh-2.5rem)] items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.10),_transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.72),rgba(255,255,255,0))] dark:bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.12),_transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col -m-6 h-[calc(100vh-2.5rem)] overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.10),_transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.72),rgba(255,255,255,0))] dark:bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.12),_transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))]">
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-10 pt-16">
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-12 shrink-0 gap-4">
          <div>
            <h1 className="text-5xl md:text-6xl font-heading text-foreground mb-3 font-normal tracking-tight">
              {t('title')}
            </h1>
            <p className="text-[17px] text-foreground/70 font-medium">{t('subtitle')}</p>
          </div>

          <div className="flex items-center gap-3 md:mt-2">
            <Button
              variant="outline"
              onClick={handleRefresh}
              disabled={gatewayStatus.state !== 'running'}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-2" />
              {t('refresh')}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2">
          {gatewayStatus.state !== 'running' && (
            <div className="mb-8 p-4 rounded-xl border border-yellow-500/50 bg-yellow-500/10 flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
              <span className="text-yellow-700 dark:text-yellow-400 text-sm font-medium">
                {t('gatewayWarning')}
              </span>
            </div>
          )}

          {error && (
            <div className="mb-8 p-4 rounded-xl border border-destructive/50 bg-destructive/10 flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-destructive" />
              <span className="text-destructive text-sm font-medium">{error}</span>
            </div>
          )}

          {configuredGroups.length > 0 && (
            <div className="mb-12">
              <h2 className="text-3xl font-heading text-foreground mb-6 font-normal tracking-tight">
                {t('configured')}
              </h2>
              <div className="space-y-4">
                {configuredGroups.map((group) => (
                  <div
                    key={group.channelType}
                    className="rounded-2xl border border-black/10 dark:border-white/10 p-4 bg-transparent"
                  >
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-[40px] w-[40px] shrink-0 flex items-center justify-center text-foreground bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-full shadow-sm">
                          <ChannelLogo type={group.channelType as ChannelType} />
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-[16px] font-semibold text-foreground truncate">
                            {CHANNEL_NAMES[group.channelType as ChannelType] || group.channelType}
                          </h3>
                          <p className="text-[12px] text-muted-foreground">{group.channelType}</p>
                        </div>
                        <div
                          className={cn(
                            'w-2 h-2 rounded-full shrink-0',
                            group.status === 'connected'
                              ? 'bg-green-500'
                              : group.status === 'connecting'
                                ? 'bg-yellow-500 animate-pulse'
                                : group.status === 'error'
                                  ? 'bg-destructive'
                                  : 'bg-muted-foreground'
                          )}
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs rounded-full"
                          onClick={() => {
                            const shouldUseGeneratedAccountId = !usesPluginManagedQrAccounts(
                              group.channelType
                            );
                            const nextAccountId = shouldUseGeneratedAccountId
                              ? createNewAccountId(
                                  group.channelType,
                                  group.accounts.map((item) => item.accountId)
                                )
                              : undefined;
                            setSelectedChannelType(group.channelType as ChannelType);
                            setSelectedAccountId(nextAccountId);
                            setAllowExistingConfigInModal(false);
                            setAllowEditAccountIdInModal(shouldUseGeneratedAccountId);
                            setExistingAccountIdsForModal(
                              group.accounts.map((item) => item.accountId)
                            );
                            setInitialConfigValuesForModal(undefined);
                            setShowConfigModal(true);
                          }}
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />
                          {t('account.add')}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setDeleteTarget({ channelType: group.channelType })}
                          title={t('account.deleteChannel')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {group.accounts.map((account) => {
                        const displayName =
                          account.accountId === 'default' && account.name === account.accountId
                            ? t('account.mainAccount')
                            : account.name;
                        return (
                          <div
                            key={`${group.channelType}-${account.accountId}`}
                            className="rounded-xl bg-black/5 dark:bg-white/5 px-3 py-2"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="text-[13px] font-medium text-foreground truncate">
                                    {displayName}
                                  </p>
                                </div>
                                {account.lastError && (
                                  <div className="text-[12px] text-destructive mt-1">
                                    {account.lastError}
                                  </div>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">
                                  {t('account.bindAgentLabel')}
                                </span>
                                <select
                                  className="h-8 rounded-lg border border-black/10 dark:border-white/10 bg-background px-2 text-xs"
                                  value={account.agentId || ''}
                                  onChange={(event) => {
                                    void handleBindAgent(
                                      group.channelType,
                                      account.accountId,
                                      event.target.value
                                    );
                                  }}
                                >
                                  <option value="">{t('account.unassigned')}</option>
                                  {agents.map((agent) => (
                                    <option key={agent.id} value={agent.id}>
                                      {agent.name}
                                    </option>
                                  ))}
                                </select>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 text-xs rounded-full"
                                  onClick={() => {
                                    void (async () => {
                                      try {
                                        const accountParam = `?accountId=${encodeURIComponent(account.accountId)}`;
                                        const result = await hostApiFetch<{
                                          success: boolean;
                                          values?: Record<string, string>;
                                        }>(
                                          `/api/channels/config/${encodeURIComponent(group.channelType)}${accountParam}`
                                        );
                                        setInitialConfigValuesForModal(
                                          result.success ? result.values || {} : undefined
                                        );
                                      } catch {
                                        // Fall back to modal-side loading when prefetch fails.
                                        setInitialConfigValuesForModal(undefined);
                                      }
                                      setSelectedChannelType(group.channelType as ChannelType);
                                      setSelectedAccountId(account.accountId);
                                      setAllowExistingConfigInModal(true);
                                      setAllowEditAccountIdInModal(false);
                                      setExistingAccountIdsForModal([]);
                                      setShowConfigModal(true);
                                    })();
                                  }}
                                >
                                  {t('account.edit')}
                                </Button>
                                {group.channelType === 'feishu' && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 text-xs rounded-full"
                                    onClick={() =>
                                      openPairingRequestsModal(
                                        group.channelType,
                                        account.accountId
                                      )
                                    }
                                  >
                                    {t('account.viewPairingRequests')}
                                  </Button>
                                )}
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                  onClick={() =>
                                    setDeleteTarget({
                                      channelType: group.channelType,
                                      accountId: account.accountId,
                                    })
                                  }
                                  title={t('account.delete')}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mb-8">
            <h2 className="text-3xl font-heading text-foreground mb-6 font-normal tracking-tight">
              {t('supportedChannels')}
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              {unsupportedGroups.map((type) => {
                const meta = CHANNEL_META[type];
                return (
                  <button
                    key={type}
                    onClick={() => {
                      setSelectedChannelType(type);
                      setSelectedAccountId(undefined);
                      setAllowExistingConfigInModal(true);
                      setAllowEditAccountIdInModal(false);
                      setExistingAccountIdsForModal([]);
                      setInitialConfigValuesForModal(undefined);
                      setShowConfigModal(true);
                    }}
                    className={cn(
                      'group flex items-start gap-4 p-4 rounded-2xl transition-all text-left border relative overflow-hidden bg-transparent border-transparent hover:bg-black/5 dark:hover:bg-white/5'
                    )}
                  >
                    <div className="h-[46px] w-[46px] shrink-0 flex items-center justify-center text-foreground bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-full shadow-sm mb-3">
                      <ChannelLogo type={type} />
                    </div>
                    <div className="flex flex-col flex-1 min-w-0 py-0.5 mt-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-[16px] font-semibold text-foreground truncate">
                          {meta.name}
                        </h3>
                        {meta.isPlugin && (
                          <Badge
                            variant="secondary"
                            className="font-mono text-[10px] font-medium px-2 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] border-0 shadow-none text-foreground/70"
                          >
                            {t('pluginBadge')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[13.5px] text-muted-foreground line-clamp-2 leading-[1.5]">
                        {t(meta.description.replace('channels:', ''))}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {showConfigModal && (
        <ChannelConfigModal
          initialSelectedType={selectedChannelType}
          accountId={selectedAccountId}
          configuredTypes={configuredTypes}
          allowExistingConfig={allowExistingConfigInModal}
          allowEditAccountId={allowEditAccountIdInModal}
          existingAccountIds={existingAccountIdsForModal}
          initialConfigValues={initialConfigValuesForModal}
          showChannelName={false}
          onClose={() => {
            setShowConfigModal(false);
            setSelectedChannelType(null);
            setSelectedAccountId(undefined);
            setAllowExistingConfigInModal(true);
            setAllowEditAccountIdInModal(false);
            setExistingAccountIdsForModal([]);
            setInitialConfigValuesForModal(undefined);
          }}
          onChannelSaved={async () => {
            await fetchPageData();
            setShowConfigModal(false);
            setSelectedChannelType(null);
            setSelectedAccountId(undefined);
            setAllowExistingConfigInModal(true);
            setAllowEditAccountIdInModal(false);
            setExistingAccountIdsForModal([]);
            setInitialConfigValuesForModal(undefined);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={t('common.confirm', 'Confirm')}
        message={deleteTarget?.accountId ? t('account.deleteConfirm') : t('deleteConfirm')}
        confirmLabel={t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        variant="destructive"
        onConfirm={() => {
          void handleDelete();
        }}
        onCancel={() => setDeleteTarget(null)}
      />

      {pairingModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPairingModalOpen(false);
            }
          }}
        >
          <div
            className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-xl border border-black/10 dark:border-white/10 bg-card shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-black/10 dark:border-white/10">
              <div>
                <h3 className="text-[16px] font-semibold text-foreground">
                  {t('account.pairingRequestsTitle')}
                </h3>
                <p className="text-[12px] text-muted-foreground mt-0.5">
                  {t('account.pairingRequestsSubtitle', {
                    channel: pairingModalChannelType,
                    accountId: pairingModalAccountId,
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs rounded-full"
                  onClick={() => {
                    void loadPairingRequests(pairingModalChannelType, pairingModalAccountId);
                  }}
                  disabled={pairingRequestsLoading}
                >
                  {pairingRequestsLoading ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      {t('refresh')}
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                      {t('refresh')}
                    </>
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 rounded-full"
                  onClick={() => setPairingModalOpen(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="max-h-[65vh] overflow-y-auto p-4 space-y-3">
              {pairingRequestsError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-[12px] text-destructive">
                  {pairingRequestsError}
                </div>
              )}

              {!pairingRequestsLoading && !pairingRequestsError && pairingRequests.length === 0 && (
                <div className="rounded-lg border border-black/10 dark:border-white/10 bg-muted/30 p-4 text-[13px] text-muted-foreground">
                  {t('account.noPairingRequests')}
                </div>
              )}

              {pairingRequestsLoading && (
                <div className="rounded-lg border border-black/10 dark:border-white/10 bg-muted/30 p-4 flex items-center text-[13px] text-muted-foreground">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('dialog.loadingConfig')}
                </div>
              )}

              {pairingRequests.map((request) => (
                <div
                  key={`${request.code}:${request.id}:${request.createdAt}`}
                  className="rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-3 space-y-2"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
                    <div className="text-muted-foreground">
                      {t('account.pairingRequest.userId')}: <span className="font-mono text-foreground">{request.userId || request.id}</span>
                    </div>
                    <div className="text-muted-foreground">
                      {t('account.pairingRequest.code')}: <span className="font-mono text-foreground">{request.code}</span>
                    </div>
                    <div className="text-muted-foreground">
                      {t('account.pairingRequest.createdAt')}:{' '}
                      <span className="text-foreground">
                        {Number.isFinite(Date.parse(request.createdAt))
                          ? new Date(request.createdAt).toLocaleString()
                          : request.createdAt}
                      </span>
                    </div>
                    {request.lastSeenAt && (
                      <div className="text-muted-foreground">
                        {t('account.pairingRequest.lastSeenAt')}:{' '}
                        <span className="text-foreground">
                          {Number.isFinite(Date.parse(request.lastSeenAt))
                            ? new Date(request.lastSeenAt).toLocaleString()
                            : request.lastSeenAt}
                        </span>
                      </div>
                    )}
                  </div>
                  {request.meta && Object.keys(request.meta).length > 0 && (
                    <div className="rounded-md bg-muted/40 px-2 py-1.5 text-[11px] font-mono text-muted-foreground overflow-x-auto">
                      {JSON.stringify(request.meta)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChannelLogo({ type }: { type: ChannelType }) {
  switch (type) {
    case 'telegram':
      return <img src={telegramIcon} alt="Telegram" className="w-[22px] h-[22px] dark:invert" />;
    case 'discord':
      return <img src={discordIcon} alt="Discord" className="w-[22px] h-[22px] dark:invert" />;
    case 'whatsapp':
      return <img src={whatsappIcon} alt="WhatsApp" className="w-[22px] h-[22px] dark:invert" />;
    case 'wechat':
      return <img src={wechatIcon} alt="WeChat" className="w-[22px] h-[22px] dark:invert" />;
    case 'dingtalk':
      return <img src={dingtalkIcon} alt="DingTalk" className="w-[22px] h-[22px] dark:invert" />;
    case 'feishu':
      return <img src={feishuIcon} alt="Feishu" className="w-[22px] h-[22px] dark:invert" />;
    case 'wecom':
      return <img src={wecomIcon} alt="WeCom" className="w-[22px] h-[22px] dark:invert" />;
    case 'qqbot':
      return <img src={qqIcon} alt="QQ" className="w-[22px] h-[22px] dark:invert" />;
    default:
      return <span className="text-[22px]">{CHANNEL_ICONS[type] || '💬'}</span>;
  }
}

export default Channels;
