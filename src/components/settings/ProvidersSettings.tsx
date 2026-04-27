/**
 * Providers Settings Component
 * Manage AI provider configurations and API keys
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  Edit,
  Eye,
  EyeOff,
  Check,
  X,
  Loader2,
  Key,
  ExternalLink,
  Copy,
  XCircle,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  useProviderStore,
  type ProviderAccount,
  type ProviderConfig,
  type ProviderVendorInfo,
} from '@/stores/providers';
import {
  PROVIDER_TYPE_INFO,
  getProviderDocsUrl,
  type ProviderType,
  getProviderIconUrl,
  resolveProviderApiKeyForSave,
  resolveProviderModelForSave,
  shouldShowProviderModelId,
  shouldInvertInDark,
} from '@/lib/providers';
import {
  buildProviderAccountId,
  buildProviderListItems,
  hasConfiguredCredentials,
  type ProviderListItem,
} from '@/lib/provider-accounts';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { invokeIpc } from '@/lib/api-client';
import { useSettingsStore } from '@/stores/settings';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';

const inputClasses =
  'h-[44px] rounded-xl font-mono text-[13px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-sm transition-all text-foreground placeholder:text-foreground/40';
const labelClasses = 'text-[14px] text-foreground/80 font-bold';
type ArkMode = 'apikey' | 'codeplan';

function normalizeFallbackProviderIds(ids?: string[]): string[] {
  return Array.from(new Set((ids ?? []).filter(Boolean)));
}

function parseOptionalPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function formatCompactCount(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  );
}

function getProtocolBaseUrlPlaceholder(apiProtocol: ProviderAccount['apiProtocol']): string {
  if (apiProtocol === 'anthropic-messages') {
    return 'https://api.example.com/anthropic';
  }
  return 'https://api.example.com/v1';
}

function fallbackProviderIdsEqual(a?: string[], b?: string[]): boolean {
  const left = normalizeFallbackProviderIds(a).sort();
  const right = normalizeFallbackProviderIds(b).sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function normalizeFallbackModels(models?: string[]): string[] {
  return Array.from(new Set((models ?? []).map((model) => model.trim()).filter(Boolean)));
}

function fallbackModelsEqual(a?: string[], b?: string[]): boolean {
  const left = normalizeFallbackModels(a);
  const right = normalizeFallbackModels(b);
  return left.length === right.length && left.every((model, index) => model === right[index]);
}

function getUserAgentHeader(headers?: Record<string, string>): string {
  if (!headers) return '';
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'user-agent') {
      return value;
    }
  }
  return '';
}

function mergeHeadersWithUserAgent(
  headers: Record<string, string> | undefined,
  userAgent: string
): Record<string, string> {
  const next = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== 'user-agent')
  );
  const normalizedUserAgent = userAgent.trim();
  if (normalizedUserAgent) {
    next['User-Agent'] = normalizedUserAgent;
  }
  return next;
}

function isArkCodePlanMode(
  vendorId: string,
  baseUrl: string | undefined,
  modelId: string | undefined,
  codePlanPresetBaseUrl?: string,
  codePlanPresetModelId?: string
): boolean {
  if (vendorId !== 'ark' || !codePlanPresetBaseUrl || !codePlanPresetModelId) return false;
  return (
    (baseUrl || '').trim() === codePlanPresetBaseUrl &&
    (modelId || '').trim() === codePlanPresetModelId
  );
}

function shouldShowUserAgentField(account: ProviderAccount): boolean {
  return account.vendorId === 'custom';
}

function shouldShowUserAgentFieldForNewProvider(providerType: ProviderType | null): boolean {
  return providerType === 'custom';
}

function getAuthModeLabel(
  authMode: ProviderAccount['authMode'],
  t: (key: string) => string
): string {
  switch (authMode) {
    case 'api_key':
      return t('aiProviders.authModes.apiKey');
    case 'oauth_device':
      return t('aiProviders.authModes.oauthDevice');
    case 'oauth_browser':
      return t('aiProviders.authModes.oauthBrowser');
    case 'local':
      return t('aiProviders.authModes.local');
    default:
      return authMode;
  }
}

export function ProvidersSettings() {
  return <ProvidersSettingsContent />;
}

export function ProvidersSettingsContent({ showHeader = true }: { showHeader?: boolean } = {}) {
  const { t } = useTranslation('settings');
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const {
    statuses,
    accounts,
    vendors,
    defaultAccountId,
    loading,
    refreshProviderSnapshot,
    createAccount,
    removeAccount,
    updateAccount,
    setDefaultAccount,
    validateAccountApiKey,
  } = useProviderStore();

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const existingVendorIds = new Set(accounts.map((account) => account.vendorId));
  const displayProviders = useMemo(
    () => buildProviderListItems(accounts, statuses, vendors, defaultAccountId),
    [accounts, statuses, vendors, defaultAccountId]
  );

  // Fetch providers on mount
  useEffect(() => {
    refreshProviderSnapshot();
  }, [refreshProviderSnapshot]);

  const handleAddProvider = async (
    type: ProviderType,
    name: string,
    apiKey: string,
    options?: {
      baseUrl?: string;
      model?: string;
      contextWindow?: number;
      maxTokens?: number;
      fallbackModels?: string[];
      fallbackProviderIds?: string[];
      authMode?: ProviderAccount['authMode'];
      apiProtocol?: ProviderAccount['apiProtocol'];
      headers?: Record<string, string>;
    }
  ) => {
    const vendor = vendorMap.get(type);
    const id = buildProviderAccountId(type, null, vendors);
    const effectiveApiKey = resolveProviderApiKeyForSave(type, apiKey);
    try {
      await createAccount(
        {
          id,
          vendorId: type,
          label: name,
          authMode:
            options?.authMode ||
            vendor?.defaultAuthMode ||
            (type === 'ollama' ? 'local' : 'api_key'),
          baseUrl: options?.baseUrl,
          apiProtocol: options?.apiProtocol,
          headers: options?.headers,
          model: options?.model,
          contextWindow: options?.contextWindow,
          maxTokens: options?.maxTokens,
          fallbackModels: options?.fallbackModels,
          fallbackAccountIds: options?.fallbackProviderIds,
          enabled: true,
          isDefault: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        effectiveApiKey
      );

      // Auto-set as default if no default is currently configured
      if (!defaultAccountId) {
        await setDefaultAccount(id);
      }

      setShowAddDialog(false);
      toast.success(t('aiProviders.toast.added'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedAdd')}: ${error}`);
    }
  };

  const handleDeleteProvider = async (providerId: string) => {
    try {
      await removeAccount(providerId);
      toast.success(t('aiProviders.toast.deleted'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedDelete')}: ${error}`);
    }
  };

  const handleSetDefault = async (providerId: string) => {
    try {
      await setDefaultAccount(providerId);
      toast.success(t('aiProviders.toast.defaultUpdated'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedDefault')}: ${error}`);
    }
  };

  return (
    <div className="space-y-4">
      {showHeader && (
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-3xl font-heading font-normal tracking-tight text-foreground">
            {t('aiProviders.title', 'AI Providers')}
          </h2>
          <Button
            onClick={() => setShowAddDialog(true)}
            className="h-10 rounded-full px-5 text-[13px] font-medium shadow-none"
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('aiProviders.add')}
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-black/10 bg-black/[0.03] py-16 text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : displayProviders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-black/10 bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent)] px-6 py-20 text-muted-foreground dark:border-white/10 dark:bg-[linear-gradient(180deg,rgba(16,185,129,0.08),transparent)]">
          <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-xl border border-black/7 bg-white/80 shadow-sm dark:border-white/10 dark:bg-white/6">
            <Key className="h-7 w-7 opacity-70" />
          </div>
          <h3 className="mb-1 text-[17px] font-semibold text-foreground">
            {t('aiProviders.empty.title')}
          </h3>
          <p className="mb-6 max-w-sm text-center text-[13px] leading-6">
            {t('aiProviders.empty.desc')}
          </p>
          <Button
            onClick={() => setShowAddDialog(true)}
            className="h-10 rounded-full bg-primary px-6 text-white hover:bg-primary/90"
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('aiProviders.empty.cta')}
          </Button>
        </div>
      ) : (
        <div className="space-y-1 rounded-xl border border-black/7 bg-white/60 p-2 dark:border-white/10 dark:bg-white/[0.03]">
          {displayProviders.map((item) => (
            <ProviderCard
              key={item.account.id}
              item={item}
              allProviders={displayProviders}
              isDefault={item.account.id === defaultAccountId}
              isEditing={editingProvider === item.account.id}
              onEdit={() => setEditingProvider(item.account.id)}
              onCancelEdit={() => setEditingProvider(null)}
              onDelete={() => handleDeleteProvider(item.account.id)}
              onSetDefault={() => handleSetDefault(item.account.id)}
              onSaveEdits={async (payload) => {
                const updates: Partial<ProviderAccount> = {};
                if (payload.updates) {
                  if (payload.updates.baseUrl !== undefined)
                    updates.baseUrl = payload.updates.baseUrl;
                  if (payload.updates.apiProtocol !== undefined)
                    updates.apiProtocol = payload.updates.apiProtocol;
                  if (payload.updates.headers !== undefined)
                    updates.headers = payload.updates.headers;
                  if (payload.updates.model !== undefined) updates.model = payload.updates.model;
                  if (payload.updates.fallbackModels !== undefined)
                    updates.fallbackModels = payload.updates.fallbackModels;
                  if (payload.updates.fallbackProviderIds !== undefined) {
                    updates.fallbackAccountIds = payload.updates.fallbackProviderIds;
                  }
                }
                await updateAccount(item.account.id, updates, payload.newApiKey);
                setEditingProvider(null);
              }}
              onValidateKey={(key, options) => validateAccountApiKey(item.account.id, key, options)}
              devModeUnlocked={devModeUnlocked}
            />
          ))}
        </div>
      )}

      {/* Add Provider Dialog */}
      {showAddDialog && (
        <AddProviderDialog
          existingVendorIds={existingVendorIds}
          vendors={vendors}
          allProviders={displayProviders}
          onClose={() => setShowAddDialog(false)}
          onAdd={handleAddProvider}
          onValidateKey={(type, key, options) => validateAccountApiKey(type, key, options)}
          devModeUnlocked={devModeUnlocked}
        />
      )}
    </div>
  );
}

interface ProviderCardProps {
  item: ProviderListItem;
  allProviders: ProviderListItem[];
  isDefault: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
  onSaveEdits: (payload: {
    newApiKey?: string;
    updates?: Partial<ProviderConfig>;
  }) => Promise<void>;
  onValidateKey: (
    key: string,
    options?: { baseUrl?: string; apiProtocol?: ProviderAccount['apiProtocol'] }
  ) => Promise<{ valid: boolean; error?: string }>;
  devModeUnlocked: boolean;
}

function ProviderCard({
  item,
  allProviders,
  isDefault,
  isEditing,
  onEdit,
  onCancelEdit,
  onDelete,
  onSetDefault,
  onSaveEdits,
  onValidateKey,
  devModeUnlocked,
}: ProviderCardProps) {
  const { t, i18n } = useTranslation('settings');
  const { account, vendor, status } = item;
  const [newKey, setNewKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(account.baseUrl || '');
  const [apiProtocol, setApiProtocol] = useState<ProviderAccount['apiProtocol']>(
    account.apiProtocol || 'openai-completions'
  );
  const [userAgent, setUserAgent] = useState(getUserAgentHeader(account.headers));
  const [modelId, setModelId] = useState(account.model || '');
  const [contextWindowInput, setContextWindowInput] = useState(
    account.contextWindow ? String(account.contextWindow) : ''
  );
  const [maxTokensInput, setMaxTokensInput] = useState(
    account.maxTokens ? String(account.maxTokens) : ''
  );
  const [fallbackModelsText, setFallbackModelsText] = useState(
    normalizeFallbackModels(account.fallbackModels).join('\n')
  );
  const [fallbackProviderIds, setFallbackProviderIds] = useState<string[]>(
    normalizeFallbackProviderIds(account.fallbackAccountIds)
  );
  const [showKey, setShowKey] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [arkMode, setArkMode] = useState<ArkMode>('apikey');

  const typeInfo = PROVIDER_TYPE_INFO.find((t) => t.id === account.vendorId);
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const showModelIdField = shouldShowProviderModelId(typeInfo, devModeUnlocked);
  const codePlanPreset =
    typeInfo?.codePlanPresetBaseUrl && typeInfo?.codePlanPresetModelId
      ? {
          baseUrl: typeInfo.codePlanPresetBaseUrl,
          modelId: typeInfo.codePlanPresetModelId,
        }
      : null;
  const effectiveDocsUrl =
    account.vendorId === 'ark' && arkMode === 'codeplan'
      ? typeInfo?.codePlanDocsUrl || providerDocsUrl
      : providerDocsUrl;
  const canEditModelConfig = Boolean(typeInfo?.showBaseUrl || showModelIdField);
  const showUserAgentField = shouldShowUserAgentField(account);

  useEffect(() => {
    if (isEditing) {
      setNewKey('');
      setShowKey(false);
      setBaseUrl(account.baseUrl || '');
      setApiProtocol(account.apiProtocol || 'openai-completions');
      setUserAgent(getUserAgentHeader(account.headers));
      setModelId(account.model || '');
      setContextWindowInput(account.contextWindow ? String(account.contextWindow) : '');
      setMaxTokensInput(account.maxTokens ? String(account.maxTokens) : '');
      setFallbackModelsText(normalizeFallbackModels(account.fallbackModels).join('\n'));
      setFallbackProviderIds(normalizeFallbackProviderIds(account.fallbackAccountIds));
      setArkMode(
        isArkCodePlanMode(
          account.vendorId,
          account.baseUrl,
          account.model,
          typeInfo?.codePlanPresetBaseUrl,
          typeInfo?.codePlanPresetModelId
        )
          ? 'codeplan'
          : 'apikey'
      );
    }
  }, [
    isEditing,
    account.baseUrl,
    account.headers,
    account.fallbackModels,
    account.fallbackAccountIds,
    account.model,
    account.contextWindow,
    account.maxTokens,
    account.apiProtocol,
    account.vendorId,
    typeInfo?.codePlanPresetBaseUrl,
    typeInfo?.codePlanPresetModelId,
  ]);

  const fallbackOptions = allProviders.filter((candidate) => candidate.account.id !== account.id);

  const toggleFallbackProvider = (providerId: string) => {
    setFallbackProviderIds((current) =>
      current.includes(providerId)
        ? current.filter((id) => id !== providerId)
        : [...current, providerId]
    );
  };

  const handleSaveEdits = async () => {
    setSaving(true);
    try {
      const payload: { newApiKey?: string; updates?: Partial<ProviderConfig> } = {};
      const normalizedFallbackModels = normalizeFallbackModels(fallbackModelsText.split('\n'));
      const contextWindow = parseOptionalPositiveInteger(contextWindowInput);
      const maxTokens = parseOptionalPositiveInteger(maxTokensInput);

      if (newKey.trim()) {
        setValidating(true);
        const result = await onValidateKey(newKey, {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol:
            account.vendorId === 'custom' || account.vendorId === 'ollama'
              ? apiProtocol
              : undefined,
        });
        setValidating(false);
        if (!result.valid) {
          toast.error(result.error || t('aiProviders.toast.invalidKey'));
          setSaving(false);
          return;
        }
        payload.newApiKey = newKey.trim();
      }

      {
        if (showModelIdField && !modelId.trim()) {
          toast.error(t('aiProviders.toast.modelRequired'));
          setSaving(false);
          return;
        }

        const updates: Partial<ProviderConfig> = {};
        if (
          typeInfo?.showBaseUrl &&
          (baseUrl.trim() || undefined) !== (account.baseUrl || undefined)
        ) {
          updates.baseUrl = baseUrl.trim() || undefined;
        }
        if (
          (account.vendorId === 'custom' || account.vendorId === 'ollama') &&
          apiProtocol !== account.apiProtocol
        ) {
          updates.apiProtocol = apiProtocol;
        }
        if (showModelIdField && (modelId.trim() || undefined) !== (account.model || undefined)) {
          updates.model = modelId.trim() || undefined;
        }
        if (contextWindow !== account.contextWindow) {
          updates.contextWindow = contextWindow;
        }
        if (maxTokens !== account.maxTokens) {
          updates.maxTokens = maxTokens;
        }
        const existingUserAgent = getUserAgentHeader(account.headers).trim();
        const nextUserAgent = userAgent.trim();
        if (nextUserAgent !== existingUserAgent) {
          updates.headers = mergeHeadersWithUserAgent(account.headers, nextUserAgent);
        }
        if (!fallbackModelsEqual(normalizedFallbackModels, account.fallbackModels)) {
          updates.fallbackModels = normalizedFallbackModels;
        }
        if (!fallbackProviderIdsEqual(fallbackProviderIds, account.fallbackAccountIds)) {
          updates.fallbackProviderIds = normalizeFallbackProviderIds(fallbackProviderIds);
        }
        if (Object.keys(updates).length > 0) {
          payload.updates = updates;
        }
      }

      // Keep Ollama key optional in UI, but persist a placeholder when
      // editing legacy configs that have no stored key.
      if (account.vendorId === 'ollama' && !status?.hasKey && !payload.newApiKey) {
        payload.newApiKey = resolveProviderApiKeyForSave(account.vendorId, '') as string;
      }

      if (!payload.newApiKey && !payload.updates) {
        onCancelEdit();
        setSaving(false);
        return;
      }

      await onSaveEdits(payload);
      setNewKey('');
      toast.success(t('aiProviders.toast.updated'));
    } catch (error) {
      toast.error(`${t('aiProviders.toast.failedUpdate')}: ${error}`);
    } finally {
      setSaving(false);
      setValidating(false);
    }
  };

  const currentInputClasses = isDefault
    ? 'h-[40px] rounded-xl font-mono text-[13px] bg-white dark:bg-card border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-primary/50 shadow-sm'
    : inputClasses;

  const currentLabelClasses = isDefault ? 'text-[13px] text-muted-foreground' : labelClasses;
  const currentSectionLabelClasses = isDefault
    ? 'text-[14px] font-bold text-foreground/80'
    : labelClasses;
  const fallbackSummary = [
    ...normalizeFallbackModels(account.fallbackModels),
    ...normalizeFallbackProviderIds(account.fallbackAccountIds)
      .map(
        (fallbackId) =>
          allProviders.find((candidate) => candidate.account.id === fallbackId)?.account.label
      )
      .filter(Boolean),
  ].join(', ');
  const metadataItems = [
    vendor?.name || account.vendorId,
    getAuthModeLabel(account.authMode, t),
    account.model,
    typeof account.contextWindow === 'number' && account.contextWindow > 0
      ? `${t('aiProviders.dialog.contextWindow')}: ${formatCompactCount(account.contextWindow)}`
      : null,
    typeof account.maxTokens === 'number' && account.maxTokens > 0
      ? `${t('aiProviders.dialog.maxTokens')}: ${formatCompactCount(account.maxTokens)}`
      : null,
    fallbackSummary ? `${t('aiProviders.sections.fallback')}: ${fallbackSummary}` : null,
  ].filter(Boolean) as string[];

  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-lg p-3 transition-all',
        isDefault
          ? 'bg-emerald-500/5 dark:bg-emerald-500/8'
          : 'bg-transparent hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-br from-white/70 to-transparent dark:from-white/[0.04]" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <div className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[18px] border border-black/7 bg-white/88 text-foreground shadow-sm transition-transform group-hover:scale-[1.03] dark:border-white/10 dark:bg-white/8">
            <span className="text-[13px] font-bold uppercase text-foreground/70">
              {(account.model || account.vendorId || '??').slice(0, 2)}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-semibold text-[15px]">{account.label}</span>
              {isDefault && (
                <span className="flex items-center gap-1 rounded-full border border-emerald-500/15 bg-emerald-500/10 px-2.5 py-1 font-mono text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                  <Check className="h-3 w-3" />
                  {t('aiProviders.card.default')}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[12px] text-muted-foreground">
              {metadataItems.map((item) => (
                <span
                  key={item}
                  className="max-w-full truncate rounded-full border border-black/5 bg-black/[0.03] px-2.5 py-1 dark:border-white/8 dark:bg-white/[0.04]"
                  title={item}
                >
                  {item}
                </span>
              ))}
              <span
                className="inline-flex items-center gap-1 rounded-full border border-black/5 bg-black/[0.03] px-2.5 py-1 dark:border-white/8 dark:bg-white/[0.04]"
                title={
                  hasConfiguredCredentials(account, status)
                    ? t('aiProviders.card.configured')
                    : t('aiProviders.dialog.apiKeyMissing')
                }
              >
                {hasConfiguredCredentials(account, status) ? (
                  <>
                    <div className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    {t('aiProviders.card.configured')}
                  </>
                ) : (
                  <>
                    <div className="h-1.5 w-1.5 rounded-full bg-red-500" />
                    {t('aiProviders.dialog.apiKeyMissing')}
                  </>
                )}
              </span>
            </div>
          </div>
        </div>

        {!isEditing && (
          <div className="flex items-center gap-1 self-end opacity-100 transition-opacity sm:self-start sm:opacity-0 sm:group-hover:opacity-100">
            {!isDefault && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-full border border-black/7 bg-white/85 text-muted-foreground shadow-sm hover:bg-white hover:text-blue-600 dark:border-white/10 dark:bg-white/8 dark:hover:bg-card"
                onClick={onSetDefault}
                title={t('aiProviders.card.setDefault')}
              >
                <Check className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full border border-black/7 bg-white/85 text-muted-foreground shadow-sm hover:bg-white hover:text-foreground dark:border-white/10 dark:bg-white/8 dark:hover:bg-card"
              onClick={onEdit}
              title={t('aiProviders.card.editKey')}
            >
              <Edit className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full border border-black/7 bg-white/85 text-muted-foreground shadow-sm hover:bg-white hover:text-destructive dark:border-white/10 dark:bg-white/8 dark:hover:bg-card"
              onClick={onDelete}
              title={t('aiProviders.card.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {isEditing && (
        <div className="mt-4 space-y-4 border-t border-black/6 pt-4 dark:border-white/8">
          {effectiveDocsUrl && (
            <div className="flex justify-end -mt-2 mb-2">
              <a
                href={effectiveDocsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] text-blue-500 hover:text-blue-600 font-medium inline-flex items-center gap-1"
              >
                {t('aiProviders.dialog.customDoc')}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
          {canEditModelConfig && (
            <div className="space-y-3 rounded-[18px] border border-black/7 bg-white/80 p-3.5 dark:border-white/8 dark:bg-white/[0.04]">
              <p className={currentSectionLabelClasses}>{t('aiProviders.sections.model')}</p>
              {typeInfo?.showBaseUrl && (
                <div className="space-y-1.5">
                  <Label className={currentLabelClasses}>{t('aiProviders.dialog.baseUrl')}</Label>
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={getProtocolBaseUrlPlaceholder(apiProtocol)}
                    className={currentInputClasses}
                  />
                </div>
              )}
              {showModelIdField && (
                <div className="space-y-1.5 pt-2">
                  <Label className={currentLabelClasses}>{t('aiProviders.dialog.modelId')}</Label>
                  <Input
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    placeholder={typeInfo?.modelIdPlaceholder || 'provider/model-id'}
                    className={currentInputClasses}
                  />
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className={currentLabelClasses}>
                    {t('aiProviders.dialog.contextWindow', 'Context Window')}
                  </Label>
                  <Input
                    value={contextWindowInput}
                    onChange={(e) => setContextWindowInput(e.target.value)}
                    placeholder="128000"
                    inputMode="numeric"
                    className={currentInputClasses}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className={currentLabelClasses}>
                    {t('aiProviders.dialog.maxTokens', 'Max Tokens')}
                  </Label>
                  <Input
                    value={maxTokensInput}
                    onChange={(e) => setMaxTokensInput(e.target.value)}
                    placeholder="8192"
                    inputMode="numeric"
                    className={currentInputClasses}
                  />
                </div>
              </div>
              {account.vendorId === 'ark' && codePlanPreset && (
                <div className="space-y-1.5 pt-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className={currentLabelClasses}>
                      {t('aiProviders.dialog.codePlanPreset')}
                    </Label>
                    {typeInfo?.codePlanDocsUrl && (
                      <a
                        href={typeInfo.codePlanDocsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[12px] text-blue-500 hover:text-blue-600 font-medium inline-flex items-center gap-1"
                      >
                        {t('aiProviders.dialog.codePlanDoc')}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <div className="flex gap-2 text-[13px]">
                    <button
                      type="button"
                      onClick={() => {
                        setArkMode('apikey');
                        setBaseUrl(typeInfo?.defaultBaseUrl || '');
                        if (modelId.trim() === codePlanPreset.modelId) {
                          setModelId(typeInfo?.defaultModelId || '');
                        }
                      }}
                      className={cn(
                        'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                        arkMode === 'apikey'
                          ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                          : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10'
                      )}
                    >
                      {t('aiProviders.authModes.apiKey')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setArkMode('codeplan');
                        setBaseUrl(codePlanPreset.baseUrl);
                        setModelId(codePlanPreset.modelId);
                      }}
                      className={cn(
                        'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                        arkMode === 'codeplan'
                          ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                          : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10'
                      )}
                    >
                      {t('aiProviders.dialog.codePlanMode')}
                    </button>
                  </div>
                  {arkMode === 'codeplan' && (
                    <p className="text-[12px] text-muted-foreground">
                      {t('aiProviders.dialog.codePlanPresetDesc')}
                    </p>
                  )}
                </div>
              )}
              {account.vendorId === 'custom' && (
                <div className="space-y-1.5 pt-2">
                  <Label className={currentLabelClasses}>
                    {t('aiProviders.dialog.protocol', 'Protocol')}
                  </Label>
                  <div className="flex gap-2 text-[13px]">
                    <button
                      type="button"
                      onClick={() => setApiProtocol('openai-completions')}
                      className={cn(
                        'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                        apiProtocol === 'openai-completions'
                          ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                          : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10'
                      )}
                    >
                      {t('aiProviders.protocols.openaiCompletions', 'OpenAI Completions')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setApiProtocol('openai-responses')}
                      className={cn(
                        'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                        apiProtocol === 'openai-responses'
                          ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                          : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10'
                      )}
                    >
                      {t('aiProviders.protocols.openaiResponses', 'OpenAI Responses')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setApiProtocol('anthropic-messages')}
                      className={cn(
                        'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                        apiProtocol === 'anthropic-messages'
                          ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                          : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10'
                      )}
                    >
                      {t('aiProviders.protocols.anthropic', 'Anthropic')}
                    </button>
                  </div>
                </div>
              )}
              {showUserAgentField && (
                <div className="space-y-1.5 pt-2">
                  <Label className={currentLabelClasses}>{t('aiProviders.dialog.userAgent')}</Label>
                  <Input
                    value={userAgent}
                    onChange={(e) => setUserAgent(e.target.value)}
                    placeholder={t('aiProviders.dialog.userAgentPlaceholder')}
                    className={currentInputClasses}
                  />
                </div>
              )}
            </div>
          )}
          <div className="space-y-3">
            <button
              onClick={() => setShowFallback(!showFallback)}
              className="flex w-full items-center justify-between rounded-[18px] border border-black/7 bg-white/80 px-4 py-2.5 text-[14px] font-bold text-foreground/80 transition-colors hover:text-foreground dark:border-white/8 dark:bg-white/[0.04]"
            >
              <span>{t('aiProviders.sections.fallback')}</span>
              <ChevronDown
                className={cn('h-4 w-4 transition-transform', showFallback && 'rotate-180')}
              />
            </button>
            {showFallback && (
              <div className="space-y-3 rounded-[18px] border border-black/7 bg-white/80 p-3.5 dark:border-white/8 dark:bg-white/[0.04]">
                <div className="space-y-1.5">
                  <Label className={currentLabelClasses}>
                    {t('aiProviders.dialog.fallbackModelIds')}
                  </Label>
                  <textarea
                    value={fallbackModelsText}
                    onChange={(e) => setFallbackModelsText(e.target.value)}
                    placeholder={t('aiProviders.dialog.fallbackModelIdsPlaceholder')}
                    className={
                      isDefault
                        ? 'min-h-24 w-full rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-card px-3 py-2 text-[13px] font-mono outline-none focus-visible:ring-2 focus-visible:ring-primary/50 shadow-sm'
                        : 'min-h-24 w-full rounded-xl border border-black/10 dark:border-white/10 bg-muted dark:bg-muted px-3 py-2 text-[13px] font-mono outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-sm transition-all text-foreground placeholder:text-foreground/40'
                    }
                  />
                  <p className="text-[12px] text-muted-foreground">
                    {t('aiProviders.dialog.fallbackModelIdsHelp')}
                  </p>
                </div>
                <div className="space-y-2 pt-1">
                  <Label className={currentLabelClasses}>
                    {t('aiProviders.dialog.fallbackProviders')}
                  </Label>
                  {fallbackOptions.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">
                      {t('aiProviders.dialog.noFallbackOptions')}
                    </p>
                  ) : (
                    <div
                      className={cn(
                        'space-y-2 rounded-xl border border-black/10 dark:border-white/10 p-3 shadow-sm',
                        isDefault ? 'bg-white dark:bg-card' : 'bg-muted dark:bg-muted'
                      )}
                    >
                      {fallbackOptions.map((candidate) => (
                        <label
                          key={candidate.account.id}
                          className="flex items-center gap-3 text-[13px] cursor-pointer group/label"
                        >
                          <input
                            type="checkbox"
                            checked={fallbackProviderIds.includes(candidate.account.id)}
                            onChange={() => toggleFallbackProvider(candidate.account.id)}
                            className="rounded border-black/20 dark:border-white/20 text-blue-500 focus:ring-blue-500/50"
                          />
                          <span className="font-medium group-hover/label:text-blue-500 transition-colors">
                            {candidate.account.label}
                          </span>
                          <span className="text-[12px] text-muted-foreground">
                            {candidate.account.model ||
                              candidate.vendor?.name ||
                              candidate.account.vendorId}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="space-y-3 rounded-[18px] border border-black/7 bg-white/80 p-3.5 dark:border-white/8 dark:bg-white/[0.04]">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <Label className={currentSectionLabelClasses}>
                  {t('aiProviders.dialog.apiKey')}
                </Label>
                <p className="text-[12px] text-muted-foreground">
                  {hasConfiguredCredentials(account, status)
                    ? t('aiProviders.dialog.apiKeyConfigured')
                    : t('aiProviders.dialog.apiKeyMissing')}
                </p>
              </div>
              {hasConfiguredCredentials(account, status) ? (
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-green-600 dark:text-green-500 bg-green-500/10 px-2 py-1 rounded-md">
                  <div className="w-1.5 h-1.5 rounded-full bg-current" />
                  {t('aiProviders.card.configured')}
                </div>
              ) : null}
            </div>
            {typeInfo?.apiKeyUrl && (
              <div className="flex justify-start">
                <a
                  href={typeInfo.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] text-blue-500 hover:text-blue-600 hover:underline flex items-center gap-1"
                  tabIndex={-1}
                >
                  {t('aiProviders.oauth.getApiKey')} <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
            <div className="space-y-1.5 pt-1">
              <Label className={currentLabelClasses}>{t('aiProviders.dialog.replaceApiKey')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    placeholder={
                      typeInfo?.requiresApiKey
                        ? typeInfo?.placeholder
                        : typeInfo?.id === 'ollama'
                          ? t('aiProviders.notRequired')
                          : t('aiProviders.card.editKey')
                    }
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    className={cn(currentInputClasses, 'pr-10')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleSaveEdits}
                  className={cn(
                    'rounded-xl px-4 border-black/10 dark:border-white/10',
                    isDefault
                      ? 'h-[40px] bg-white dark:bg-card hover:bg-black/5 dark:hover:bg-white/10'
                      : 'h-[44px] bg-muted dark:bg-muted hover:bg-black/5 dark:hover:bg-white/10 shadow-sm'
                  )}
                  disabled={
                    validating ||
                    saving ||
                    (!newKey.trim() &&
                      (baseUrl.trim() || undefined) === (account.baseUrl || undefined) &&
                      userAgent.trim() === getUserAgentHeader(account.headers).trim() &&
                      (modelId.trim() || undefined) === (account.model || undefined) &&
                      fallbackModelsEqual(
                        normalizeFallbackModels(fallbackModelsText.split('\n')),
                        account.fallbackModels
                      ) &&
                      fallbackProviderIdsEqual(fallbackProviderIds, account.fallbackAccountIds)) ||
                    Boolean(showModelIdField && !modelId.trim())
                  }
                >
                  {validating || saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4 text-green-500" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  onClick={onCancelEdit}
                  className={cn(
                    'p-0 rounded-xl',
                    isDefault
                      ? 'h-[40px] w-[40px] hover:bg-black/5 dark:hover:bg-white/10'
                      : 'h-[44px] w-[44px] bg-muted dark:bg-muted border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/10 shadow-sm text-muted-foreground hover:text-foreground'
                  )}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-[12px] text-muted-foreground">
                {t('aiProviders.dialog.replaceApiKeyHelp')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AddProviderDialogProps {
  existingVendorIds: Set<string>;
  vendors: ProviderVendorInfo[];
  allProviders: ProviderListItem[];
  onClose: () => void;
  onAdd: (
    type: ProviderType,
    name: string,
    apiKey: string,
    options?: {
      baseUrl?: string;
      model?: string;
      contextWindow?: number;
      maxTokens?: number;
      fallbackModels?: string[];
      fallbackProviderIds?: string[];
      authMode?: ProviderAccount['authMode'];
      apiProtocol?: ProviderAccount['apiProtocol'];
      headers?: Record<string, string>;
    }
  ) => Promise<void>;
  onValidateKey: (
    type: string,
    apiKey: string,
    options?: { baseUrl?: string; apiProtocol?: ProviderAccount['apiProtocol'] }
  ) => Promise<{ valid: boolean; error?: string }>;
  devModeUnlocked: boolean;
}

function AddProviderDialog({
  existingVendorIds,
  vendors,
  allProviders,
  onClose,
  onAdd,
  onValidateKey,
  devModeUnlocked,
}: AddProviderDialogProps) {
  const { t, i18n } = useTranslation('settings');
  const [selectedType, setSelectedType] = useState<ProviderType | null>(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [contextWindowInput, setContextWindowInput] = useState('');
  const [maxTokensInput, setMaxTokensInput] = useState('');
  const [showFallback, setShowFallback] = useState(false);
  const [fallbackModelsText, setFallbackModelsText] = useState('');
  const [fallbackProviderIds, setFallbackProviderIds] = useState<string[]>([]);
  const [apiProtocol, setApiProtocol] =
    useState<ProviderAccount['apiProtocol']>('openai-completions');
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [userAgent, setUserAgent] = useState('');
  const [arkMode, setArkMode] = useState<ArkMode>('apikey');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // OAuth Flow State
  const [oauthFlowing, setOauthFlowing] = useState(false);
  const [oauthData, setOauthData] = useState<
    | {
        mode: 'device';
        verificationUri: string;
        userCode: string;
        expiresIn: number;
      }
    | {
        mode: 'manual';
        authorizationUrl: string;
        message?: string;
      }
    | null
  >(null);
  const [manualCodeInput, setManualCodeInput] = useState('');
  const [oauthError, setOauthError] = useState<string | null>(null);
  // For providers that support both OAuth and API key, let the user choose.
  // Default to the vendor's declared auth mode instead of hard-coding OAuth.
  const [authMode, setAuthMode] = useState<'oauth' | 'apikey'>('apikey');

  const typeInfo = PROVIDER_TYPE_INFO.find((t) => t.id === selectedType);
  const providerDocsUrl = getProviderDocsUrl(typeInfo, i18n.language);
  const showModelIdField = shouldShowProviderModelId(typeInfo, devModeUnlocked);
  const codePlanPreset =
    typeInfo?.codePlanPresetBaseUrl && typeInfo?.codePlanPresetModelId
      ? {
          baseUrl: typeInfo.codePlanPresetBaseUrl,
          modelId: typeInfo.codePlanPresetModelId,
        }
      : null;
  const effectiveDocsUrl =
    selectedType === 'ark' && arkMode === 'codeplan'
      ? typeInfo?.codePlanDocsUrl || providerDocsUrl
      : providerDocsUrl;
  const isOAuth = typeInfo?.isOAuth ?? false;
  const supportsApiKey = typeInfo?.supportsApiKey ?? false;
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const selectedVendor = selectedType ? vendorMap.get(selectedType) : undefined;
  const showUserAgentInAddDialog = shouldShowUserAgentFieldForNewProvider(selectedType);
  const fallbackOptions = allProviders;
  const toggleFallbackProvider = (providerId: string) => {
    setFallbackProviderIds((current) =>
      current.includes(providerId)
        ? current.filter((id) => id !== providerId)
        : [...current, providerId]
    );
  };
  const preferredOAuthMode = selectedVendor?.supportedAuthModes.includes('oauth_browser')
    ? 'oauth_browser'
    : selectedVendor?.supportedAuthModes.includes('oauth_device')
      ? 'oauth_device'
      : selectedType === 'google'
        ? 'oauth_browser'
        : null;
  // Effective OAuth mode: pure OAuth providers, or dual-mode with oauth selected
  const useOAuthFlow = isOAuth && (!supportsApiKey || authMode === 'oauth');

  useEffect(() => {
    if (!selectedVendor || !isOAuth || !supportsApiKey) {
      return;
    }
    setAuthMode(selectedVendor.defaultAuthMode === 'api_key' ? 'apikey' : 'oauth');
  }, [selectedVendor, isOAuth, supportsApiKey]);

  useEffect(() => {
    if (selectedType !== 'ark') {
      setArkMode('apikey');
      return;
    }
    setArkMode(
      isArkCodePlanMode(
        'ark',
        baseUrl,
        modelId,
        typeInfo?.codePlanPresetBaseUrl,
        typeInfo?.codePlanPresetModelId
      )
        ? 'codeplan'
        : 'apikey'
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType]);

  // Keep refs to the latest values so event handlers see the current dialog state.
  const latestRef = React.useRef({ selectedType, typeInfo, onAdd, onClose, t });
  const pendingOAuthRef = React.useRef<{ accountId: string; label: string } | null>(null);
  useEffect(() => {
    latestRef.current = { selectedType, typeInfo, onAdd, onClose, t };
  });

  // Manage OAuth events
  useEffect(() => {
    const handleCode = (data: unknown) => {
      const payload = data as Record<string, unknown>;
      if (payload?.mode === 'manual') {
        setOauthData({
          mode: 'manual',
          authorizationUrl: String(payload.authorizationUrl || ''),
          message: typeof payload.message === 'string' ? payload.message : undefined,
        });
      } else {
        setOauthData({
          mode: 'device',
          verificationUri: String(payload.verificationUri || ''),
          userCode: String(payload.userCode || ''),
          expiresIn: Number(payload.expiresIn || 300),
        });
      }
      setOauthError(null);
    };

    const handleSuccess = async (data: unknown) => {
      setOauthFlowing(false);
      setOauthData(null);
      setManualCodeInput('');
      setValidationError(null);

      const { onClose: close, t: translate } = latestRef.current;
      const payload = (data as { accountId?: string } | undefined) || undefined;
      const accountId = payload?.accountId || pendingOAuthRef.current?.accountId;

      // device-oauth.ts already saved the provider config to the backend,
      // including the dynamically resolved baseUrl for the region (e.g. CN vs Global).
      // If we call add() here with undefined baseUrl, it will overwrite and erase it!
      // So we just fetch the latest list from the backend to update the UI.
      try {
        const store = useProviderStore.getState();
        await store.refreshProviderSnapshot();

        // OAuth sign-in should immediately become active default to avoid
        // leaving runtime on an API-key-only provider/model.
        if (accountId) {
          await store.setDefaultAccount(accountId);
        }
      } catch (err) {
        console.error('Failed to refresh providers after OAuth:', err);
      }

      pendingOAuthRef.current = null;
      close();
      toast.success(translate('aiProviders.toast.added'));
    };

    const handleError = (data: unknown) => {
      setOauthError((data as { message: string }).message);
      setOauthData(null);
      pendingOAuthRef.current = null;
    };

    const offCode = subscribeHostEvent('oauth:code', handleCode);
    const offSuccess = subscribeHostEvent('oauth:success', handleSuccess);
    const offError = subscribeHostEvent('oauth:error', handleError);

    return () => {
      offCode();
      offSuccess();
      offError();
    };
  }, []);

  const handleStartOAuth = async () => {
    if (!selectedType) return;

    const hasMinimax =
      existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
    if ((selectedType === 'minimax-portal' || selectedType === 'minimax-portal-cn') && hasMinimax) {
      toast.error(t('aiProviders.toast.minimaxConflict'));
      return;
    }

    setOauthFlowing(true);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);

    try {
      const vendor = vendorMap.get(selectedType);
      const supportsMultipleAccounts =
        vendor?.supportsMultipleAccounts ?? selectedType === 'custom';
      const accountId = supportsMultipleAccounts
        ? `${selectedType}-${crypto.randomUUID()}`
        : selectedType;
      const label =
        name ||
        (typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name) ||
        selectedType;
      pendingOAuthRef.current = { accountId, label };
      await hostApiFetch('/api/providers/oauth/start', {
        method: 'POST',
        body: JSON.stringify({ provider: selectedType, accountId, label }),
      });
    } catch (e) {
      setOauthError(String(e));
      setOauthFlowing(false);
      pendingOAuthRef.current = null;
    }
  };

  const handleCancelOAuth = async () => {
    setOauthFlowing(false);
    setOauthData(null);
    setManualCodeInput('');
    setOauthError(null);
    pendingOAuthRef.current = null;
    await hostApiFetch('/api/providers/oauth/cancel', {
      method: 'POST',
    });
  };

  const handleSubmitManualOAuthCode = async () => {
    const value = manualCodeInput.trim();
    if (!value) return;
    try {
      await hostApiFetch('/api/providers/oauth/submit', {
        method: 'POST',
        body: JSON.stringify({ code: value }),
      });
      setOauthError(null);
    } catch (error) {
      setOauthError(String(error));
    }
  };

  const availableTypes = PROVIDER_TYPE_INFO.filter((type) => {
    // MiniMax portal variants are mutually exclusive — hide BOTH variants
    // when either one already exists (account may have vendorId of either variant).
    const hasMinimax =
      existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
    if ((type.id === 'minimax-portal' || type.id === 'minimax-portal-cn') && hasMinimax)
      return false;

    const vendor = vendorMap.get(type.id);
    if (!vendor) {
      return !existingVendorIds.has(type.id) || type.id === 'custom';
    }
    return vendor.supportsMultipleAccounts || !existingVendorIds.has(type.id);
  });

  const handleAdd = async () => {
    if (!selectedType) return;

    const hasMinimax =
      existingVendorIds.has('minimax-portal') || existingVendorIds.has('minimax-portal-cn');
    if ((selectedType === 'minimax-portal' || selectedType === 'minimax-portal-cn') && hasMinimax) {
      toast.error(t('aiProviders.toast.minimaxConflict'));
      return;
    }

    setSaving(true);
    setValidationError(null);

    try {
      // Validate key first if the provider requires one and a key was entered
      const requiresKey = typeInfo?.requiresApiKey ?? false;
      if (requiresKey && !apiKey.trim()) {
        setValidationError(t('aiProviders.toast.invalidKey')); // reusing invalid key msg or should add 'required' msg? null checks
        setSaving(false);
        return;
      }
      if (requiresKey && apiKey) {
        const result = await onValidateKey(selectedType, apiKey, {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol:
            selectedType === 'custom' || selectedType === 'ollama' ? apiProtocol : undefined,
        });
        if (!result.valid) {
          setValidationError(result.error || t('aiProviders.toast.invalidKey'));
          setSaving(false);
          return;
        }
      }

      const requiresModel = showModelIdField;
      const contextWindow = parseOptionalPositiveInteger(contextWindowInput);
      const maxTokens = parseOptionalPositiveInteger(maxTokensInput);
      const normalizedFallbackModels = normalizeFallbackModels(fallbackModelsText.split('\n'));
      if (requiresModel && !modelId.trim()) {
        setValidationError(t('aiProviders.toast.modelRequired'));
        setSaving(false);
        return;
      }

      await onAdd(
        selectedType,
        name ||
          (typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name) ||
          selectedType,
        apiKey.trim(),
        {
          baseUrl: baseUrl.trim() || undefined,
          apiProtocol:
            selectedType === 'custom' || selectedType === 'ollama' ? apiProtocol : undefined,
          headers: userAgent.trim() ? { 'User-Agent': userAgent.trim() } : undefined,
          model: resolveProviderModelForSave(typeInfo, modelId, devModeUnlocked),
          contextWindow,
          maxTokens,
          fallbackModels: normalizedFallbackModels,
          fallbackProviderIds: normalizeFallbackProviderIds(fallbackProviderIds),
          authMode: useOAuthFlow
            ? preferredOAuthMode || 'oauth_device'
            : selectedType === 'ollama'
              ? 'local'
              : isOAuth && supportsApiKey && authMode === 'apikey'
                ? 'api_key'
                : vendorMap.get(selectedType)?.defaultAuthMode || 'api_key',
        }
      );
    } catch {
      // error already handled via toast in parent
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <Card className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-[32px] border border-black/7 bg-card shadow-[0_40px_110px_-35px_rgba(15,23,42,0.65)] dark:border-white/10 dark:bg-card">
        <CardHeader className="relative shrink-0 border-b border-black/6 bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent)] pb-4 dark:border-white/8 dark:bg-[linear-gradient(180deg,rgba(16,185,129,0.10),transparent)]">
          <CardTitle className="text-2xl font-heading font-normal">
            {t('aiProviders.dialog.title')}
          </CardTitle>
          <CardDescription className="text-[15px] mt-1 text-foreground/70">
            {t('aiProviders.dialog.desc')}
          </CardDescription>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-4 top-4 rounded-full h-8 w-8 -mr-2 -mt-2 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto p-6">
          {!selectedType ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {availableTypes.map((type) => (
                <button
                  key={type.id}
                  onClick={() => {
                    setSelectedType(type.id);
                    setName(type.id === 'custom' ? t('aiProviders.custom') : type.name);
                    setBaseUrl(type.defaultBaseUrl || '');
                    setModelId(type.defaultModelId || '');
                    setUserAgent('');
                    setShowAdvancedConfig(false);
                    setArkMode('apikey');
                  }}
                  className="group rounded-xl border border-black/7 bg-white/72 p-4 text-center transition-colors hover:bg-black/5 dark:border-white/8 dark:bg-white/[0.04] dark:hover:bg-white/[0.06]"
                >
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[16px] border border-black/7 bg-background/90 shadow-sm transition-transform group-hover:scale-105 dark:border-white/8 dark:bg-background/60">
                    {getProviderIconUrl(type.id) ? (
                      <img
                        src={getProviderIconUrl(type.id)}
                        alt={type.name}
                        className={cn('h-6 w-6', shouldInvertInDark(type.id) && 'dark:invert')}
                      />
                    ) : (
                      <span className="text-2xl">{type.icon}</span>
                    )}
                  </div>
                  <p className="font-medium text-[13px]">
                    {type.id === 'custom' ? t('aiProviders.custom') : type.name}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center gap-3 rounded-xl border border-black/7 bg-white/72 p-4 shadow-sm dark:border-white/8 dark:bg-white/[0.04]">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-black/5 dark:bg-white/5">
                  {getProviderIconUrl(selectedType!) ? (
                    <img
                      src={getProviderIconUrl(selectedType!)}
                      alt={typeInfo?.name}
                      className={cn('h-6 w-6', shouldInvertInDark(selectedType!) && 'dark:invert')}
                    />
                  ) : (
                    <span className="text-xl">{typeInfo?.icon}</span>
                  )}
                </div>
                <div>
                  <p className="font-semibold text-[15px]">
                    {typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name}
                  </p>
                  <button
                    onClick={() => {
                      setSelectedType(null);
                      setValidationError(null);
                      setBaseUrl('');
                      setModelId('');
                      setContextWindowInput('');
                      setMaxTokensInput('');
                      setUserAgent('');
                      setShowAdvancedConfig(false);
                      setArkMode('apikey');
                    }}
                    className="text-[13px] text-blue-500 hover:text-blue-600 font-medium"
                  >
                    {t('aiProviders.dialog.change')}
                  </button>
                  {effectiveDocsUrl && (
                    <>
                      <span className="mx-2 text-foreground/20">|</span>
                      <a
                        href={effectiveDocsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[13px] text-blue-500 hover:text-blue-600 font-medium inline-flex items-center gap-1"
                      >
                        {t('aiProviders.dialog.customDoc')}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-6 bg-transparent p-0">
                <div className="space-y-2.5">
                  <Label htmlFor="name" className={labelClasses}>
                    {t('aiProviders.dialog.displayName')}
                  </Label>
                  <Input
                    id="name"
                    placeholder={
                      typeInfo?.id === 'custom' ? t('aiProviders.custom') : typeInfo?.name
                    }
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputClasses}
                  />
                </div>

                {/* Auth mode toggle for providers supporting both */}
                {isOAuth && supportsApiKey && (
                  <div className="flex rounded-xl border border-black/10 dark:border-white/10 overflow-hidden text-[13px] font-medium shadow-sm bg-muted dark:bg-muted p-1 gap-1">
                    <button
                      onClick={() => setAuthMode('oauth')}
                      className={cn(
                        'flex-1 py-2 px-3 rounded-lg transition-colors',
                        authMode === 'oauth'
                          ? 'bg-black/10 dark:bg-white/10 text-foreground'
                          : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5'
                      )}
                    >
                      {t('aiProviders.oauth.loginMode')}
                    </button>
                    <button
                      onClick={() => setAuthMode('apikey')}
                      className={cn(
                        'flex-1 py-2 px-3 rounded-lg transition-colors',
                        authMode === 'apikey'
                          ? 'bg-black/10 dark:bg-white/10 text-foreground'
                          : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5'
                      )}
                    >
                      {t('aiProviders.oauth.apikeyMode')}
                    </button>
                  </div>
                )}

                {/* API Key input — shown for non-OAuth providers or when apikey mode is selected */}
                {(!isOAuth || (supportsApiKey && authMode === 'apikey')) && (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="apiKey" className={labelClasses}>
                        {t('aiProviders.dialog.apiKey')}
                      </Label>
                      {typeInfo?.apiKeyUrl && (
                        <a
                          href={typeInfo.apiKeyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[13px] text-blue-500 hover:text-blue-600 font-medium flex items-center gap-1"
                          tabIndex={-1}
                        >
                          {t('aiProviders.oauth.getApiKey')} <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="relative">
                      <Input
                        id="apiKey"
                        type={showKey ? 'text' : 'password'}
                        placeholder={
                          typeInfo?.id === 'ollama'
                            ? t('aiProviders.notRequired')
                            : typeInfo?.placeholder
                        }
                        value={apiKey}
                        onChange={(e) => {
                          setApiKey(e.target.value);
                          setValidationError(null);
                        }}
                        className={inputClasses}
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    {validationError && (
                      <p className="text-[13px] text-red-500 font-medium">{validationError}</p>
                    )}
                    <p className="text-[12px] text-muted-foreground">
                      {t('aiProviders.dialog.apiKeyStored')}
                    </p>
                  </div>
                )}

                {typeInfo?.showBaseUrl && (
                  <div className="space-y-2.5">
                    <Label htmlFor="baseUrl" className={labelClasses}>
                      {t('aiProviders.dialog.baseUrl')}
                    </Label>
                    <Input
                      id="baseUrl"
                      placeholder={getProtocolBaseUrlPlaceholder(apiProtocol)}
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      className={inputClasses}
                    />
                  </div>
                )}

                {showModelIdField && (
                  <div className="space-y-2.5">
                    <Label htmlFor="modelId" className={labelClasses}>
                      {t('aiProviders.dialog.modelId')}
                    </Label>
                    <Input
                      id="modelId"
                      placeholder={typeInfo?.modelIdPlaceholder || 'provider/model-id'}
                      value={modelId}
                      onChange={(e) => {
                        setModelId(e.target.value);
                        setValidationError(null);
                      }}
                      className={inputClasses}
                    />
                  </div>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-2.5">
                    <Label htmlFor="contextWindow" className={labelClasses}>
                      {t('aiProviders.dialog.contextWindow', 'Context Window')}
                    </Label>
                    <Input
                      id="contextWindow"
                      placeholder="128000"
                      value={contextWindowInput}
                      onChange={(e) => setContextWindowInput(e.target.value)}
                      inputMode="numeric"
                      className={inputClasses}
                    />
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="maxTokens" className={labelClasses}>
                      {t('aiProviders.dialog.maxTokens', 'Max Tokens')}
                    </Label>
                    <Input
                      id="maxTokens"
                      placeholder="8192"
                      value={maxTokensInput}
                      onChange={(e) => setMaxTokensInput(e.target.value)}
                      inputMode="numeric"
                      className={inputClasses}
                    />
                  </div>
                </div>
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setShowFallback((value) => !value)}
                    className="flex w-full items-center justify-between rounded-[18px] border border-black/7 bg-white/80 px-4 py-2.5 text-[14px] font-bold text-foreground/80 transition-colors hover:text-foreground dark:border-white/8 dark:bg-white/[0.04]"
                  >
                    <span>{t('aiProviders.sections.fallback')}</span>
                    <ChevronDown
                      className={cn('h-4 w-4 transition-transform', showFallback && 'rotate-180')}
                    />
                  </button>
                  {showFallback && (
                    <div className="space-y-3 rounded-[18px] border border-black/7 bg-white/80 p-3.5 dark:border-white/8 dark:bg-white/[0.04]">
                      <div className="space-y-1.5">
                        <Label className={labelClasses}>
                          {t('aiProviders.dialog.fallbackModelIds')}
                        </Label>
                        <textarea
                          value={fallbackModelsText}
                          onChange={(e) => setFallbackModelsText(e.target.value)}
                          placeholder={t('aiProviders.dialog.fallbackModelIdsPlaceholder')}
                          className="min-h-24 w-full rounded-xl border border-black/10 dark:border-white/10 bg-muted dark:bg-muted px-3 py-2 text-[13px] font-mono outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-sm transition-all text-foreground placeholder:text-foreground/40"
                        />
                        <p className="text-[12px] text-muted-foreground">
                          {t('aiProviders.dialog.fallbackModelIdsHelp')}
                        </p>
                      </div>
                      <div className="space-y-2 pt-1">
                        <Label className={labelClasses}>
                          {t('aiProviders.dialog.fallbackProviders')}
                        </Label>
                        {fallbackOptions.length === 0 ? (
                          <p className="text-[13px] text-muted-foreground">
                            {t('aiProviders.dialog.noFallbackOptions')}
                          </p>
                        ) : (
                          <div className="space-y-2 rounded-xl border border-black/10 dark:border-white/10 p-3 shadow-sm bg-muted dark:bg-muted">
                            {fallbackOptions.map((candidate) => (
                              <label
                                key={candidate.account.id}
                                className="flex items-center gap-3 text-[13px] cursor-pointer group/label"
                              >
                                <input
                                  type="checkbox"
                                  checked={fallbackProviderIds.includes(candidate.account.id)}
                                  onChange={() => toggleFallbackProvider(candidate.account.id)}
                                  className="rounded border-black/20 dark:border-white/20 text-blue-500 focus:ring-blue-500/50"
                                />
                                <span className="font-medium group-hover/label:text-blue-500 transition-colors">
                                  {candidate.account.label}
                                </span>
                                <span className="text-[12px] text-muted-foreground">
                                  {candidate.account.model ||
                                    candidate.vendor?.name ||
                                    candidate.account.vendorId}
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                {selectedType === 'ark' && codePlanPreset && (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label className={labelClasses}>
                        {t('aiProviders.dialog.codePlanPreset')}
                      </Label>
                      {typeInfo?.codePlanDocsUrl && (
                        <a
                          href={typeInfo.codePlanDocsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[13px] text-blue-500 hover:text-blue-600 font-medium inline-flex items-center gap-1"
                          tabIndex={-1}
                        >
                          {t('aiProviders.dialog.codePlanDoc')}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex gap-2 text-[13px]">
                      <button
                        type="button"
                        onClick={() => {
                          setArkMode('apikey');
                          setBaseUrl(typeInfo?.defaultBaseUrl || '');
                          if (modelId.trim() === codePlanPreset.modelId) {
                            setModelId(typeInfo?.defaultModelId || '');
                          }
                          setValidationError(null);
                        }}
                        className={cn(
                          'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                          arkMode === 'apikey'
                            ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                            : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10'
                        )}
                      >
                        {t('aiProviders.authModes.apiKey')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setArkMode('codeplan');
                          setBaseUrl(codePlanPreset.baseUrl);
                          setModelId(codePlanPreset.modelId);
                          setValidationError(null);
                        }}
                        className={cn(
                          'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                          arkMode === 'codeplan'
                            ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                            : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10'
                        )}
                      >
                        {t('aiProviders.dialog.codePlanMode')}
                      </button>
                    </div>
                    {arkMode === 'codeplan' && (
                      <p className="text-[12px] text-muted-foreground">
                        {t('aiProviders.dialog.codePlanPresetDesc')}
                      </p>
                    )}
                  </div>
                )}
                {selectedType === 'custom' && (
                  <div className="space-y-2.5">
                    <Label className={labelClasses}>
                      {t('aiProviders.dialog.protocol', 'Protocol')}
                    </Label>
                    <div className="flex gap-2 text-[13px]">
                      <button
                        type="button"
                        onClick={() => setApiProtocol('openai-completions')}
                        className={cn(
                          'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                          apiProtocol === 'openai-completions'
                            ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                            : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10'
                        )}
                      >
                        {t('aiProviders.protocols.openaiCompletions', 'OpenAI Completions')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setApiProtocol('openai-responses')}
                        className={cn(
                          'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                          apiProtocol === 'openai-responses'
                            ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                            : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10'
                        )}
                      >
                        {t('aiProviders.protocols.openaiResponses', 'OpenAI Responses')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setApiProtocol('anthropic-messages')}
                        className={cn(
                          'flex-1 py-1.5 px-3 rounded-lg border transition-colors',
                          apiProtocol === 'anthropic-messages'
                            ? 'bg-white dark:bg-card border-black/20 dark:border-white/20 shadow-sm font-medium'
                            : 'border-transparent bg-black/5 dark:bg-white/5 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10'
                        )}
                      >
                        {t('aiProviders.protocols.anthropic', 'Anthropic')}
                      </button>
                    </div>
                  </div>
                )}
                {showUserAgentInAddDialog && (
                  <div className="space-y-2.5">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedConfig((value) => !value)}
                      className="flex items-center justify-between w-full text-[14px] font-bold text-foreground/80 hover:text-foreground transition-colors"
                    >
                      <span>{t('aiProviders.dialog.advancedConfig')}</span>
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 transition-transform',
                          showAdvancedConfig && 'rotate-180'
                        )}
                      />
                    </button>
                    {showAdvancedConfig && (
                      <div className="space-y-2.5 pt-1">
                        <Label htmlFor="userAgent" className={labelClasses}>
                          {t('aiProviders.dialog.userAgent')}
                        </Label>
                        <Input
                          id="userAgent"
                          placeholder={t('aiProviders.dialog.userAgentPlaceholder')}
                          value={userAgent}
                          onChange={(e) => setUserAgent(e.target.value)}
                          className={inputClasses}
                        />
                      </div>
                    )}
                  </div>
                )}
                {/* Device OAuth Trigger — only shown when in OAuth mode */}
                {useOAuthFlow && (
                  <div className="space-y-4 pt-2">
                    <div className="rounded-xl bg-blue-500/10 border border-blue-500/20 p-5 text-center">
                      <p className="text-[13px] font-medium text-blue-600 dark:text-blue-400 mb-4 block">
                        {t('aiProviders.oauth.loginPrompt')}
                      </p>
                      <Button
                        onClick={handleStartOAuth}
                        disabled={oauthFlowing}
                        className="w-full rounded-full h-[42px] font-semibold bg-primary hover:bg-primary/90 text-white shadow-sm"
                      >
                        {oauthFlowing ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            {t('aiProviders.oauth.waiting')}
                          </>
                        ) : (
                          t('aiProviders.oauth.loginButton')
                        )}
                      </Button>
                    </div>

                    {/* OAuth Active State Modal / Inline View */}
                    {oauthFlowing && (
                      <div className="mt-4 p-5 border border-black/10 dark:border-white/10 rounded-2xl bg-white dark:bg-card shadow-sm relative overflow-hidden">
                        {/* Background pulse effect */}
                        <div className="absolute inset-0 bg-blue-500/5 animate-pulse" />

                        <div className="relative z-10 flex flex-col items-center justify-center text-center space-y-5">
                          {oauthError ? (
                            <div className="text-red-500 space-y-3">
                              <XCircle className="h-10 w-10 mx-auto" />
                              <p className="font-semibold text-[15px]">
                                {t('aiProviders.oauth.authFailed')}
                              </p>
                              <p className="text-[13px] opacity-80">{oauthError}</p>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={handleCancelOAuth}
                                className="mt-2 rounded-full px-6 h-9"
                              >
                                Try Again
                              </Button>
                            </div>
                          ) : !oauthData ? (
                            <div className="space-y-4 py-6">
                              <Loader2 className="h-10 w-10 animate-spin text-blue-500 mx-auto" />
                              <p className="text-[13px] font-medium text-muted-foreground animate-pulse">
                                {t('aiProviders.oauth.requestingCode')}
                              </p>
                            </div>
                          ) : oauthData.mode === 'manual' ? (
                            <div className="space-y-4 w-full">
                              <div className="space-y-2">
                                <h3 className="font-semibold text-[16px] text-foreground">
                                  Complete OpenAI Login
                                </h3>
                                <p className="text-[13px] text-muted-foreground text-left bg-black/5 dark:bg-white/5 p-4 rounded-xl">
                                  {oauthData.message ||
                                    'Open the authorization page, complete login, then paste the callback URL or code below.'}
                                </p>
                              </div>

                              <Button
                                variant="secondary"
                                className="w-full rounded-full h-[42px] font-semibold"
                                onClick={() =>
                                  invokeIpc('shell:openExternal', oauthData.authorizationUrl)
                                }
                              >
                                <ExternalLink className="h-4 w-4 mr-2" />
                                Open Authorization Page
                              </Button>

                              <Input
                                placeholder="Paste callback URL or code"
                                value={manualCodeInput}
                                onChange={(e) => setManualCodeInput(e.target.value)}
                                className={inputClasses}
                              />

                              <Button
                                className="w-full rounded-full h-[42px] font-semibold bg-primary hover:bg-primary/90 text-white"
                                onClick={handleSubmitManualOAuthCode}
                                disabled={!manualCodeInput.trim()}
                              >
                                Submit Code
                              </Button>

                              <Button
                                variant="ghost"
                                className="w-full rounded-full h-[42px] font-semibold text-muted-foreground"
                                onClick={handleCancelOAuth}
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <div className="space-y-5 w-full">
                              <div className="space-y-2">
                                <h3 className="font-semibold text-[16px] text-foreground">
                                  {t('aiProviders.oauth.approveLogin')}
                                </h3>
                                <div className="text-[13px] text-muted-foreground text-left mt-2 space-y-1.5 bg-black/5 dark:bg-white/5 p-4 rounded-xl">
                                  <p>1. {t('aiProviders.oauth.step1')}</p>
                                  <p>2. {t('aiProviders.oauth.step2')}</p>
                                  <p>3. {t('aiProviders.oauth.step3')}</p>
                                </div>
                              </div>

                              <div className="flex items-center justify-center gap-3 p-4 bg-muted dark:bg-muted border border-black/5 dark:border-white/5 rounded-xl shadow-inner">
                                <code className="text-3xl font-mono tracking-[0.2em] font-bold text-foreground">
                                  {oauthData.userCode}
                                </code>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-10 w-10 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
                                  onClick={() => {
                                    navigator.clipboard.writeText(oauthData.userCode);
                                    toast.success(t('aiProviders.oauth.codeCopied'));
                                  }}
                                >
                                  <Copy className="h-5 w-5" />
                                </Button>
                              </div>

                              <Button
                                variant="secondary"
                                className="w-full rounded-full h-[42px] font-semibold"
                                onClick={() =>
                                  invokeIpc('shell:openExternal', oauthData.verificationUri)
                                }
                              >
                                <ExternalLink className="h-4 w-4 mr-2" />
                                {t('aiProviders.oauth.openLoginPage')}
                              </Button>

                              <div className="flex items-center justify-center gap-2 text-[13px] font-medium text-muted-foreground pt-2">
                                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                                <span>{t('aiProviders.oauth.waitingApproval')}</span>
                              </div>

                              <Button
                                variant="ghost"
                                className="w-full rounded-full h-[42px] font-semibold text-muted-foreground"
                                onClick={handleCancelOAuth}
                              >
                                Cancel
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <Separator className="bg-black/10 dark:bg-white/10" />

              <div className="flex justify-end gap-3">
                <Button
                  onClick={handleAdd}
                  className={cn(
                    'rounded-full px-8 h-[42px] text-[13px] font-semibold bg-primary hover:bg-primary/90 text-white shadow-sm',
                    useOAuthFlow && 'hidden'
                  )}
                  disabled={
                    !selectedType || saving || (showModelIdField && modelId.trim().length === 0)
                  }
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  {t('aiProviders.dialog.add')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
