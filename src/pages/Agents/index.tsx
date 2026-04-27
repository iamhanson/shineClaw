import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, Download, Plus, RefreshCw, Settings2, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useAgentsStore } from '@/stores/agents';
import { useGatewayStore } from '@/stores/gateway';
import { useProviderStore } from '@/stores/providers';
import { useSkillsStore } from '@/stores/skills';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import { invokeIpc } from '@/lib/api-client';
import { buildProviderListItems, getOpenClawProviderKeyForAccount } from '@/lib/provider-accounts';
import { CHANNEL_ICONS, CHANNEL_NAMES, type ChannelType } from '@/types/channel';
import type { AgentSummary } from '@/types/agent';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
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

export function Agents() {
  const { t } = useTranslation('agents');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const lastGatewayStateRef = useRef(gatewayStatus.state);
  const { agents, loading, error, fetchAgents, createAgent, importAgent, deleteAgent } = useAgentsStore();
  const [channelGroups, setChannelGroups] = useState<ChannelGroupItem[]>([]);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentToDelete, setAgentToDelete] = useState<AgentSummary | null>(null);

  const fetchChannelAccounts = useCallback(async () => {
    try {
      const response = await hostApiFetch<{ success: boolean; channels?: ChannelGroupItem[] }>(
        '/api/channels/accounts'
      );
      setChannelGroups(response.channels || []);
    } catch {
      setChannelGroups([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void Promise.all([fetchAgents(), fetchChannelAccounts()]);
  }, [fetchAgents, fetchChannelAccounts]);

  useEffect(() => {
    const unsubscribe = subscribeHostEvent('gateway:channel-status', () => {
      void fetchChannelAccounts();
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [fetchChannelAccounts]);

  useEffect(() => {
    const previousGatewayState = lastGatewayStateRef.current;
    lastGatewayStateRef.current = gatewayStatus.state;

    if (previousGatewayState !== 'running' && gatewayStatus.state === 'running') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchChannelAccounts();
    }
  }, [fetchChannelAccounts, gatewayStatus.state]);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) ?? null,
    [activeAgentId, agents]
  );
  const handleRefresh = () => {
    void Promise.all([fetchAgents(), fetchChannelAccounts()]);
  };

  if (loading) {
    return (
      <div className="flex flex-col -m-6 min-h-[calc(100vh-2.5rem)] items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.10),_transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.72),rgba(255,255,255,0))] dark:bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.12),_transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col -m-6 h-[calc(100vh-2.5rem)] overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.10),_transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.72),rgba(255,255,255,0))] dark:bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.12),_transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))]">
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-8 pt-10 md:p-10 md:pt-12">
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-6 shrink-0 gap-4">
          <div>
            <h1 className="text-[26px] md:text-[32px] font-heading text-foreground mb-2 font-normal tracking-tight">
              {t('title')}
            </h1>
            <p className="text-[13px] text-foreground/70 font-medium">{t('subtitle')}</p>
          </div>
          <div className="flex items-center gap-3 md:mt-2">
            <Button
              variant="outline"
              onClick={handleRefresh}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-2" />
              {t('refresh')}
            </Button>
            <Button
              onClick={() => setShowAddDialog(true)}
              className="h-9 text-[13px] font-medium rounded-full px-4 shadow-none"
            >
              <Plus className="h-3.5 w-3.5 mr-2" />
              {t('addAgent')}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowImportDialog(true)}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground transition-colors"
            >
              <Download className="h-3.5 w-3.5 mr-2" />
              {t('importAgent')}
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

          <div className="space-y-3">
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                channelGroups={channelGroups}
                onOpenSettings={() => setActiveAgentId(agent.id)}
                onDelete={() => setAgentToDelete(agent)}
              />
            ))}
          </div>
        </div>
      </div>

      {showAddDialog && (
        <AddAgentDialog
          onClose={() => setShowAddDialog(false)}
          onCreate={async (name, options) => {
            await createAgent(name, options);
            setShowAddDialog(false);
            toast.success(t('toast.agentCreated'));
          }}
        />
      )}

      {showImportDialog && (
        <ImportAgentDialog
          onClose={() => setShowImportDialog(false)}
          onImport={async (payload) => {
            await importAgent(payload);
            setShowImportDialog(false);
            toast.success(t('toast.agentImported'));
          }}
        />
      )}

      {activeAgent && (
        <AgentSettingsModal
          agent={activeAgent}
          channelGroups={channelGroups}
          onClose={() => setActiveAgentId(null)}
        />
      )}

      <ConfirmDialog
        open={!!agentToDelete}
        title={t('deleteDialog.title')}
        message={agentToDelete ? t('deleteDialog.message', { name: agentToDelete.name }) : ''}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (!agentToDelete) return;
          try {
            await deleteAgent(agentToDelete.id);
            const deletedId = agentToDelete.id;
            setAgentToDelete(null);
            if (activeAgentId === deletedId) {
              setActiveAgentId(null);
            }
            toast.success(t('toast.agentDeleted'));
          } catch (error) {
            toast.error(t('toast.agentDeleteFailed', { error: String(error) }));
          }
        }}
        onCancel={() => setAgentToDelete(null)}
      />
    </div>
  );
}

function AgentCard({
  agent,
  channelGroups,
  onOpenSettings,
  onDelete,
}: {
  agent: AgentSummary;
  channelGroups: ChannelGroupItem[];
  onOpenSettings: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('agents');
  const boundChannelAccounts = channelGroups.flatMap((group) =>
    group.accounts
      .filter((account) => account.agentId === agent.id)
      .map((account) => {
        const channelName = CHANNEL_NAMES[group.channelType as ChannelType] || group.channelType;
        const accountLabel =
          account.accountId === 'default'
            ? t('settingsDialog.mainAccount')
            : account.name || account.accountId;
        return `${channelName} · ${accountLabel}`;
      })
  );
  const channelsText =
    boundChannelAccounts.length > 0 ? boundChannelAccounts.join(', ') : t('none');

  return (
    <div
      className={cn(
        'group flex items-start gap-4 p-4 rounded-2xl transition-all text-left border relative overflow-hidden bg-transparent border-transparent hover:bg-black/5 dark:hover:bg-white/5',
        agent.isDefault && 'bg-black/[0.04] dark:bg-white/[0.06]'
      )}
    >
      <div className="h-[46px] w-[46px] shrink-0 flex items-center justify-center text-primary bg-primary/10 rounded-full shadow-sm mb-3">
        <Bot className="h-[22px] w-[22px]" />
      </div>
      <div className="flex flex-col flex-1 min-w-0 py-0.5 mt-1">
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-[16px] font-semibold text-foreground truncate">
              {agent.isDefault ? t('defaultAgentName') : agent.name}
            </h2>
            {agent.isDefault && (
              <Badge
                variant="secondary"
                className="flex items-center gap-1 font-mono text-[10px] font-medium px-2 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] border-0 shadow-none text-foreground/70"
              >
                <Check className="h-3 w-3" />
                {t('defaultBadge')}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!agent.isDefault && (
              <Button
                variant="ghost"
                size="icon"
                className="opacity-0 group-hover:opacity-100 h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                onClick={onDelete}
                title={t('deleteAgent')}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10 transition-all',
                !agent.isDefault && 'opacity-0 group-hover:opacity-100'
              )}
              onClick={onOpenSettings}
              title={t('settings')}
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <p className="text-[13.5px] text-muted-foreground line-clamp-2 leading-[1.5]">
          {t('modelLine', {
            model: agent.modelDisplay,
            suffix: agent.inheritedModel ? ` (${t('inherited')})` : '',
          })}
        </p>
        <p className="text-[13.5px] text-muted-foreground line-clamp-2 leading-[1.5]">
          {t('channelsLine', { channels: channelsText })}
        </p>
      </div>
    </div>
  );
}

const inputClasses =
  'h-[44px] rounded-xl font-mono text-[13px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-sm transition-all text-foreground placeholder:text-foreground/40';
const labelClasses = 'text-[14px] text-foreground/80 font-bold';

function ChannelLogo({ type }: { type: ChannelType }) {
  switch (type) {
    case 'telegram':
      return <img src={telegramIcon} alt="Telegram" className="w-[20px] h-[20px] dark:invert" />;
    case 'discord':
      return <img src={discordIcon} alt="Discord" className="w-[20px] h-[20px] dark:invert" />;
    case 'whatsapp':
      return <img src={whatsappIcon} alt="WhatsApp" className="w-[20px] h-[20px] dark:invert" />;
    case 'wechat':
      return <img src={wechatIcon} alt="WeChat" className="w-[20px] h-[20px] dark:invert" />;
    case 'dingtalk':
      return <img src={dingtalkIcon} alt="DingTalk" className="w-[20px] h-[20px] dark:invert" />;
    case 'feishu':
      return <img src={feishuIcon} alt="Feishu" className="w-[20px] h-[20px] dark:invert" />;
    case 'wecom':
      return <img src={wecomIcon} alt="WeCom" className="w-[20px] h-[20px] dark:invert" />;
    case 'qqbot':
      return <img src={qqIcon} alt="QQ" className="w-[20px] h-[20px] dark:invert" />;
    default:
      return <span className="text-[20px] leading-none">{CHANNEL_ICONS[type] || '💬'}</span>;
  }
}

function AddAgentDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (
    name: string,
    options: {
      agentId?: string;
      inheritWorkspace: boolean;
      model?: string;
      preferredSkills?: string[];
      instructions?: string;
    },
  ) => Promise<void>;
}) {
  const { t } = useTranslation('agents');
  const existingAgents = useAgentsStore((s) => s.agents);
  const existingAgentIds = useMemo(
    () => existingAgents.map((agent) => agent.id.toLowerCase()),
    [existingAgents]
  );
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [agentIdTouched, setAgentIdTouched] = useState(false);
  const [inheritWorkspace, setInheritWorkspace] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const accounts = useProviderStore((s) => s.accounts);
  const statuses = useProviderStore((s) => s.statuses);
  const vendors = useProviderStore((s) => s.vendors);
  const defaultAccountId = useProviderStore((s) => s.defaultAccountId);
  const refreshProviderSnapshot = useProviderStore((s) => s.refreshProviderSnapshot);
  const skills = useSkillsStore((s) => s.skills);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const providerItems = useMemo(
    () => buildProviderListItems(accounts, statuses, vendors, defaultAccountId),
    [accounts, statuses, vendors, defaultAccountId]
  );
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    for (const item of providerItems) {
      const modelId = (item.account.model || '').trim();
      if (!modelId) continue;
      const runtimeProviderKey = getOpenClawProviderKeyForAccount(item.account);
      const value = `${runtimeProviderKey}/${modelId}`;
      if (seen.has(value)) continue;
      seen.add(value);
      options.push({
        value,
        label: `${modelId} (${item.account.label || runtimeProviderKey})`,
      });
    }
    return options;
  }, [providerItems]);
  const selectableSkills = useMemo(
    () =>
      (Array.isArray(skills) ? skills : [])
        .filter((skill) => skill.enabled)
        .sort((a, b) => {
          const rank = (source?: string): number => {
            const value = (source || '').toLowerCase();
            if (value.includes('workspace')) return 0;
            if (!value.includes('bundled')) return 1;
            return 2;
          };
          const diff = rank(a.source) - rank(b.source);
          if (diff !== 0) return diff;
          return a.name.localeCompare(b.name);
        }),
    [skills]
  );

  useEffect(() => {
    void refreshProviderSnapshot();
    void fetchSkills();
    // Only fetch once when dialog mounts; depending on function identity here
    // can cause update loops in some store update cycles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (agentIdTouched) return;
    const normalized = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const charMap: Record<string, string> = {
      我: 'wo',
      你: 'ni',
      他: 'ta',
      她: 'ta',
      它: 'ta',
      们: 'men',
      好: 'hao',
      很: 'hen',
      棒: 'bang',
      的: 'de',
      代: 'dai',
      码: 'ma',
      小: 'xiao',
      能: 'neng',
      手: 'shou',
      智: 'zhi',
      体: 'ti',
      助: 'zhu',
      理: 'li',
      阿: 'a',
      山: 'shan',
      工: 'gong',
      作: 'zuo',
      区: 'qu',
    };
    const chars = Array.from(normalized);
    const mapped = chars
      .map((char) => {
        if (/^[a-z0-9-]$/.test(char)) return char;
        if (charMap[char]) return `-${charMap[char]}-`;
        return '';
      })
      .join('')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const nextAgentId = mapped || 'agent';
    setAgentId((prev) => (prev === nextAgentId ? prev : nextAgentId));
  }, [agentIdTouched, name]);

  const normalizedAgentId = useMemo(
    () =>
      agentId
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-'),
    [agentId]
  );
  const isAgentIdValid = /^[a-z0-9-]+$/.test(normalizedAgentId) && normalizedAgentId !== 'main';
  const isAgentIdDuplicate = existingAgentIds.includes(normalizedAgentId);

  const handleToggleSkill = (skillId: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skillId) ? prev.filter((id) => id !== skillId) : [...prev, skillId]
    );
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const normalizedCustomModel = customModel.trim();
      const finalModel = normalizedCustomModel || selectedModel.trim();
      await onCreate(name.trim(), {
        agentId: normalizedAgentId,
        inheritWorkspace,
        model: finalModel || undefined,
        preferredSkills: selectedSkills,
        instructions: instructions.trim() || undefined,
      });
    } catch (error) {
      toast.error(t('toast.agentCreateFailed', { error: String(error) }));
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-md max-h-[90vh] flex flex-col rounded-xl border-0 shadow-2xl bg-card dark:bg-card overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-2xl font-heading font-normal tracking-tight">
            {t('createDialog.title')}
          </CardTitle>
          <CardDescription className="text-[15px] mt-1 text-foreground/70">
            {t('createDialog.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pt-4 p-6 overflow-y-auto flex-1">
          <div className="space-y-2.5">
            <Label htmlFor="agent-name" className={labelClasses}>
              {t('createDialog.nameLabel')}
            </Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('createDialog.namePlaceholder')}
              className={inputClasses}
            />
          </div>
          <div className="space-y-2.5">
            <Label htmlFor="agent-id" className={labelClasses}>
              {t('createDialog.idLabel')}
            </Label>
            <Input
              id="agent-id"
              value={agentId}
              onChange={(event) => {
                setAgentIdTouched(true);
                setAgentId(event.target.value);
              }}
              placeholder={t('createDialog.idPlaceholder')}
              className={inputClasses}
            />
            {!isAgentIdValid && normalizedAgentId.length > 0 && (
              <p className="text-[12px] text-destructive">{t('createDialog.idInvalid')}</p>
            )}
            {isAgentIdDuplicate && (
              <p className="text-[12px] text-destructive">{t('createDialog.idDuplicate')}</p>
            )}
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="inherit-workspace" className={labelClasses}>
                {t('createDialog.inheritWorkspaceLabel')}
              </Label>
              <p className="text-[13px] text-foreground/60">
                {t('createDialog.inheritWorkspaceDescription')}
              </p>
            </div>
            <input
              id="inherit-workspace"
              type="checkbox"
              checked={inheritWorkspace}
              onChange={(event) => setInheritWorkspace(event.target.checked)}
              className="h-4 w-4 rounded border-black/20 text-primary focus:ring-primary/40"
            />
          </div>
          <div className="space-y-2.5">
            <Label htmlFor="agent-model" className={labelClasses}>
              {t('createDialog.modelLabel')}
            </Label>
            <select
              id="agent-model"
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              className={cn(inputClasses, 'w-full px-3')}
            >
              <option value="">{t('createDialog.modelInheritDefault')}</option>
              {modelOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2.5">
            <Label htmlFor="agent-custom-model" className={labelClasses}>
              {t('createDialog.customModelLabel')}
            </Label>
            <Input
              id="agent-custom-model"
              value={customModel}
              onChange={(event) => setCustomModel(event.target.value)}
              placeholder={t('createDialog.customModelPlaceholder')}
              className={inputClasses}
            />
          </div>
          <div className="space-y-2.5">
            <Label className={labelClasses}>{t('createDialog.skillsLabel')}</Label>
            <p className="text-[13px] text-foreground/60">{t('createDialog.skillsDescription')}</p>
            <div className="max-h-40 overflow-y-auto rounded-xl border border-black/10 bg-muted dark:border-white/10 dark:bg-muted p-2">
              {selectableSkills.length > 0 ? (
                <div className="space-y-1">
                  {selectableSkills.map((skill) => {
                    const checked = selectedSkills.includes(skill.id);
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => handleToggleSkill(skill.id)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors',
                          checked
                            ? 'bg-black/10 dark:bg-white/12'
                            : 'hover:bg-black/5 dark:hover:bg-white/8'
                        )}
                      >
                        <span className="truncate text-[13px] text-foreground">
                          {skill.name} ({skill.id})
                        </span>
                        <span
                          className={cn(
                            'ml-2 h-4 w-4 rounded border flex items-center justify-center',
                            checked
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-black/20 dark:border-white/20'
                          )}
                        >
                          {checked && <Check className="h-3 w-3" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="px-2 py-3 text-[13px] text-muted-foreground">
                  {t('createDialog.noSkills')}
                </div>
              )}
            </div>
          </div>
          <div className="space-y-2.5">
            <Label htmlFor="agent-instructions" className={labelClasses}>
              {t('createDialog.instructionsLabel')}
            </Label>
            <Textarea
              id="agent-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t('createDialog.instructionsPlaceholder')}
              className="min-h-[90px] rounded-xl font-mono text-[13px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-sm transition-all text-foreground placeholder:text-foreground/40"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={onClose}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={() => void handleSubmit()}
              disabled={saving || !name.trim() || !normalizedAgentId || !isAgentIdValid || isAgentIdDuplicate}
              className="h-9 text-[13px] font-medium rounded-full px-4 shadow-none"
            >
              {saving ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  {t('creating')}
                </>
              ) : (
                t('common:actions.save')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ImportAgentDialog({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (payload: { filePath?: string; url?: string }) => Promise<void>;
}) {
  const { t } = useTranslation('agents');
  const [sourceType, setSourceType] = useState<'file' | 'url'>('file');
  const [filePath, setFilePath] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [importing, setImporting] = useState(false);

  const pickImportFile = useCallback(async () => {
    try {
      const result = (await invokeIpc('dialog:open', {
        properties: ['openFile'],
        filters: [
          { name: 'Agent files', extensions: ['json', 'md', 'txt'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })) as { canceled: boolean; filePaths?: string[] };
      if (result.canceled || !result.filePaths?.length) return;
      setFilePath(result.filePaths[0]);
    } catch (error) {
      toast.error(t('toast.agentImportFailed', { error: String(error) }));
    }
  }, [t]);

  const handleSubmit = useCallback(async () => {
    const trimmedPath = filePath.trim();
    const trimmedUrl = remoteUrl.trim();
    const payload = sourceType === 'file'
      ? { filePath: trimmedPath }
      : { url: trimmedUrl };
    if ((sourceType === 'file' && !trimmedPath) || (sourceType === 'url' && !trimmedUrl)) {
      return;
    }
    setImporting(true);
    try {
      await onImport(payload);
    } catch (error) {
      toast.error(t('toast.agentImportFailed', { error: String(error) }));
      setImporting(false);
      return;
    }
    setImporting(false);
  }, [filePath, onImport, remoteUrl, sourceType, t]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-md rounded-xl border-0 shadow-2xl bg-card dark:bg-card overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-2xl font-heading font-normal tracking-tight">
            {t('importDialog.title')}
          </CardTitle>
          <CardDescription className="text-[15px] mt-1 text-foreground/70">
            {t('importDialog.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4 p-6">
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/70 p-1">
            <button
              type="button"
              onClick={() => setSourceType('file')}
              className={cn(
                'h-9 rounded-lg text-[13px] font-medium transition-colors',
                sourceType === 'file'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t('importDialog.fromFile')}
            </button>
            <button
              type="button"
              onClick={() => setSourceType('url')}
              className={cn(
                'h-9 rounded-lg text-[13px] font-medium transition-colors',
                sourceType === 'url'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t('importDialog.fromUrl')}
            </button>
          </div>

          {sourceType === 'file' ? (
            <div className="space-y-2">
              <Label className={labelClasses}>{t('importDialog.fileLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  value={filePath}
                  onChange={(event) => setFilePath(event.target.value)}
                  placeholder={t('importDialog.filePlaceholder')}
                  className={inputClasses}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void pickImportFile()}
                  className="h-[44px] rounded-xl border-black/10 dark:border-white/10 bg-muted dark:bg-muted hover:bg-black/5 dark:hover:bg-white/5 text-[13px]"
                >
                  {t('importDialog.browse')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label className={labelClasses}>{t('importDialog.urlLabel')}</Label>
              <Input
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
                placeholder={t('importDialog.urlPlaceholder')}
                className={inputClasses}
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              onClick={onClose}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={() => void handleSubmit()}
              disabled={
                importing ||
                (sourceType === 'file' ? !filePath.trim() : !remoteUrl.trim())
              }
              className="h-9 text-[13px] font-medium rounded-full px-4 shadow-none"
            >
              {importing ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  {t('importing')}
                </>
              ) : (
                t('importAgent')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AgentSettingsModal({
  agent,
  channelGroups,
  onClose,
}: {
  agent: AgentSummary;
  channelGroups: ChannelGroupItem[];
  onClose: () => void;
}) {
  const { t } = useTranslation('agents');
  const { updateAgent } = useAgentsStore();
  const accounts = useProviderStore((s) => s.accounts);
  const statuses = useProviderStore((s) => s.statuses);
  const vendors = useProviderStore((s) => s.vendors);
  const defaultAccountId = useProviderStore((s) => s.defaultAccountId);
  const refreshProviderSnapshot = useProviderStore((s) => s.refreshProviderSnapshot);
  const providerItems = useMemo(
    () => buildProviderListItems(accounts, statuses, vendors, defaultAccountId),
    [accounts, statuses, vendors, defaultAccountId]
  );
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    for (const item of providerItems) {
      const modelId = (item.account.model || '').trim();
      if (!modelId) continue;
      const runtimeProviderKey = getOpenClawProviderKeyForAccount(item.account);
      const value = `${runtimeProviderKey}/${modelId}`;
      if (seen.has(value)) continue;
      seen.add(value);
      options.push({
        value,
        label: `${modelId} (${item.account.label || runtimeProviderKey})`,
      });
    }
    return options;
  }, [providerItems]);
  const [name, setName] = useState(agent.name);
  const [savingName, setSavingName] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [savingModel, setSavingModel] = useState(false);

  useEffect(() => {
    setName(agent.name);
  }, [agent.name]);

  useEffect(() => {
    void refreshProviderSnapshot();
    // Fetch once when modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const currentModel = (agent.model || '').trim();
    if (!currentModel) {
      setSelectedModel('');
      setCustomModel('');
      return;
    }
    const inOptions = modelOptions.some((item) => item.value === currentModel);
    setSelectedModel(inOptions ? currentModel : '');
    setCustomModel(inOptions ? '' : currentModel);
  }, [agent.model, modelOptions]);

  const handleSaveName = async () => {
    if (!name.trim() || name.trim() === agent.name) return;
    setSavingName(true);
    try {
      await updateAgent(agent.id, { name: name.trim() });
      toast.success(t('toast.agentUpdated'));
    } catch (error) {
      toast.error(t('toast.agentUpdateFailed', { error: String(error) }));
    } finally {
      setSavingName(false);
    }
  };

  const handleSaveModel = async () => {
    const nextModel = customModel.trim() || selectedModel.trim() || null;
    const currentModel = (agent.model || '').trim() || null;
    if (nextModel === currentModel) return;
    setSavingModel(true);
    try {
      await updateAgent(agent.id, { model: nextModel });
      toast.success(t('toast.agentUpdated'));
    } catch (error) {
      toast.error(t('toast.agentUpdateFailed', { error: String(error) }));
    } finally {
      setSavingModel(false);
    }
  };

  const assignedChannels = channelGroups.flatMap((group) =>
    group.accounts
      .filter((account) => account.agentId === agent.id)
      .map((account) => ({
        channelType: group.channelType as ChannelType,
        accountId: account.accountId,
        name:
          account.accountId === 'default'
            ? t('settingsDialog.mainAccount')
            : account.name || account.accountId,
        error: account.lastError,
      }))
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl border-0 shadow-2xl bg-card dark:bg-card overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between pb-2 shrink-0">
          <div>
            <CardTitle className="text-2xl font-heading font-normal tracking-tight">
              {t('settingsDialog.title', {
                name: agent.isDefault ? t('defaultAgentName') : agent.name,
              })}
            </CardTitle>
            <CardDescription className="text-[15px] mt-1 text-foreground/70">
              {t('settingsDialog.description')}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="rounded-full h-8 w-8 -mr-2 -mt-2 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-6 pt-4 overflow-y-auto flex-1 p-6">
          <div className="space-y-4">
            <div className="space-y-2.5">
              <Label htmlFor="agent-settings-name" className={labelClasses}>
                {t('settingsDialog.nameLabel')}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="agent-settings-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  readOnly={agent.isDefault}
                  className={inputClasses}
                />
                {!agent.isDefault && (
                  <Button
                    variant="outline"
                    onClick={() => void handleSaveName()}
                    disabled={savingName || !name.trim() || name.trim() === agent.name}
                    className="h-[44px] text-[13px] font-medium rounded-xl px-4 border-black/10 dark:border-white/10 bg-muted dark:bg-muted hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
                  >
                    {savingName ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      t('common:actions.save')
                    )}
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-2.5">
              <Label htmlFor="agent-settings-model" className={labelClasses}>
                {t('createDialog.modelLabel')}
              </Label>
              <div className="flex gap-2">
                <select
                  id="agent-settings-model"
                  value={selectedModel}
                  onChange={(event) => {
                    setSelectedModel(event.target.value);
                    if (event.target.value) setCustomModel('');
                  }}
                  className={cn(inputClasses, 'w-full px-3')}
                >
                  <option value="">{t('createDialog.modelInheritDefault')}</option>
                  {modelOptions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  onClick={() => void handleSaveModel()}
                  disabled={savingModel}
                  className="h-[44px] text-[13px] font-medium rounded-xl px-4 border-black/10 dark:border-white/10 bg-muted dark:bg-muted hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
                >
                  {savingModel ? <RefreshCw className="h-4 w-4 animate-spin" /> : t('common:actions.save')}
                </Button>
              </div>
            </div>

            <div className="space-y-2.5">
              <Label htmlFor="agent-settings-custom-model" className={labelClasses}>
                {t('createDialog.customModelLabel')}
              </Label>
              <Input
                id="agent-settings-custom-model"
                value={customModel}
                onChange={(event) => {
                  setCustomModel(event.target.value);
                  if (event.target.value.trim()) setSelectedModel('');
                }}
                placeholder={t('createDialog.customModelPlaceholder')}
                className={inputClasses}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1 rounded-2xl bg-black/5 dark:bg-white/5 border border-transparent p-4">
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground/80 font-medium">
                  {t('settingsDialog.agentIdLabel')}
                </p>
                <p className="font-mono text-[13px] text-foreground">{agent.id}</p>
              </div>
              <div className="space-y-1 rounded-2xl bg-black/5 dark:bg-white/5 border border-transparent p-4">
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground/80 font-medium">
                  {t('settingsDialog.modelLabel')}
                </p>
                <p className="text-[13.5px] text-foreground">
                  {agent.modelDisplay}
                  {agent.inheritedModel ? ` (${t('inherited')})` : ''}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-heading text-foreground font-normal tracking-tight">
                  {t('settingsDialog.channelsTitle')}
                </h3>
                <p className="text-[14px] text-foreground/70 mt-1">
                  {t('settingsDialog.channelsDescription')}
                </p>
              </div>
            </div>

            {assignedChannels.length === 0 && agent.channelTypes.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 text-[13.5px] text-muted-foreground">
                {t('settingsDialog.noChannels')}
              </div>
            ) : (
              <div className="space-y-3">
                {assignedChannels.map((channel) => (
                  <div
                    key={`${channel.channelType}-${channel.accountId}`}
                    className="flex items-center justify-between rounded-2xl bg-black/5 dark:bg-white/5 border border-transparent p-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-[40px] w-[40px] shrink-0 flex items-center justify-center text-foreground bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-full shadow-sm">
                        <ChannelLogo type={channel.channelType} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[15px] font-semibold text-foreground">{channel.name}</p>
                        <p className="text-[13.5px] text-muted-foreground">
                          {CHANNEL_NAMES[channel.channelType]} ·{' '}
                          {channel.accountId === 'default'
                            ? t('settingsDialog.mainAccount')
                            : channel.accountId}
                        </p>
                        {channel.error && (
                          <p className="text-xs text-destructive mt-1">{channel.error}</p>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0" />
                  </div>
                ))}
                {assignedChannels.length === 0 && agent.channelTypes.length > 0 && (
                  <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 text-[13.5px] text-muted-foreground">
                    {t('settingsDialog.channelsManagedInChannels')}
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default Agents;
