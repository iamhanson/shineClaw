import type { IncomingMessage, ServerResponse } from 'http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deleteChannelAccountConfig,
  deleteChannelConfig,
  cleanupDanglingWeChatPluginState,
  getChannelFormValues,
  listConfiguredChannelAccounts,
  listConfiguredChannels,
  readOpenClawConfig,
  saveChannelConfig,
  setChannelDefaultAccount,
  setChannelEnabled,
  validateChannelConfig,
  validateChannelCredentials,
} from '../../utils/channel-config';
import {
  assignChannelAccountToAgent,
  clearAllBindingsForChannel,
  clearChannelBinding,
  listAgentsSnapshot,
} from '../../utils/agent-config';
import {
  ensureDingTalkPluginInstalled,
  ensureFeishuPluginInstalled,
  ensureQQBotPluginInstalled,
  ensureWeChatPluginInstalled,
  ensureWeComPluginInstalled,
} from '../../utils/plugin-install';
import {
  computeChannelRuntimeStatus,
  pickChannelRuntimeStatus,
  type ChannelRuntimeAccountSnapshot,
} from '../../utils/channel-status';
import {
  OPENCLAW_WECHAT_CHANNEL_TYPE,
  UI_WECHAT_CHANNEL_TYPE,
  buildQrChannelEventName,
  toOpenClawChannelType,
  toUiChannelType,
} from '../../utils/channel-alias';
import {
  cancelWeChatLoginSession,
  saveWeChatAccountState,
  startWeChatLoginSession,
  waitForWeChatLoginSession,
} from '../../utils/wechat-login';
import { whatsAppLoginManager } from '../../utils/whatsapp-login';
import { getOpenClawConfigDir } from '../../utils/paths';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const WECHAT_QR_TIMEOUT_MS = 8 * 60 * 1000;
const activeQrLogins = new Map<string, string>();

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface ChannelPairingRequestView {
  id: string;
  userId: string;
  code: string;
  createdAt: string;
  lastSeenAt?: string;
  accountId?: string;
  meta?: Record<string, string>;
}

function stripThreadSuffixFromSessionKey(sessionKey: string): string {
  const idx = sessionKey.toLowerCase().lastIndexOf(':thread:');
  if (idx <= 0) return sessionKey;
  const parentKey = sessionKey.slice(0, idx).trim();
  return parentKey || sessionKey;
}

function parseAgentSessionKey(sessionKey: string): { rest: string } | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 3) return null;
  const rest = parts.slice(2).join(':').trim();
  if (!rest) return null;
  return { rest };
}

function inferDeliveryFromSessionKey(sessionKey: string): { channel?: string; to: string } | null {
  const parsed = parseAgentSessionKey(stripThreadSuffixFromSessionKey(sessionKey));
  if (!parsed?.rest) return null;

  const parts = parsed.rest.split(':').filter(Boolean);
  if (parts.length === 0) return null;

  const head = parts[0]?.trim().toLowerCase();
  if (!head || head === 'main' || head === 'subagent' || head === 'acp' || head === 'cron') {
    return null;
  }

  const markerIndex = parts.findIndex(
    (part) => part === 'direct' || part === 'dm' || part === 'group' || part === 'channel',
  );
  if (markerIndex === -1) return null;

  const to = parts.slice(markerIndex + 1).join(':').trim();
  if (!to) return null;

  return {
    channel: parts[0]?.trim().toLowerCase() || undefined,
    to,
  };
}

type SessionStoreCandidate = { sessionKey: string; entry: Record<string, unknown> };

async function readSessionStoreEntries(agentId: string): Promise<SessionStoreCandidate[]> {
  const storePath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', 'sessions.json');
  const raw = await readFile(storePath, 'utf8').catch(() => '');
  if (!raw.trim()) return [];

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidates = new Map<string, Record<string, unknown>>();

    for (const [sessionKey, value] of Object.entries(parsed)) {
      if (sessionKey === 'sessions' || !isRecord(value)) continue;
      candidates.set(sessionKey, value);
    }

    const sessions = parsed.sessions;
    if (Array.isArray(sessions)) {
      for (const item of sessions) {
        if (!isRecord(item)) continue;
        const sessionKey = normalizeString(item.key) || normalizeString(item.sessionKey);
        if (!sessionKey) continue;
        candidates.set(sessionKey, item);
      }
    }

    return Array.from(candidates.entries()).map(([sessionKey, entry]) => ({ sessionKey, entry }));
  } catch {
    return [];
  }
}

async function listRecipientCandidatesFromOpenClaw(params: {
  channelType: string;
  accountId?: string;
  limit?: number;
}): Promise<string[]> {
  const storedChannelType = resolveStoredChannelType(params.channelType);
  const targetAccountId = normalizeString(params.accountId);
  const maxItems = Math.max(1, Math.min(params.limit ?? 50, 200));
  const scored = new Map<string, number>();

  const openClawConfig = await readOpenClawConfig().catch(() => ({ channels: {} as Record<string, unknown> }));
  const channelSection = (openClawConfig.channels?.[storedChannelType] as Record<string, unknown> | undefined) ?? undefined;
  const accounts = (channelSection?.accounts as Record<string, Record<string, unknown>> | undefined) ?? undefined;
  if (accounts) {
    const accountEntries: Array<[string, Record<string, unknown>]> = [];
    if (targetAccountId) {
      const matched = accounts[targetAccountId];
      if (matched) {
        accountEntries.push([targetAccountId, matched]);
      }
    } else {
      accountEntries.push(...Object.entries(accounts));
    }
    for (const [, accountCfg] of accountEntries) {
      const fromConfig =
        normalizeString(accountCfg.defaultRecipientId)
        || normalizeString(accountCfg.deliveryTo)
        || normalizeString(accountCfg.to);
      if (fromConfig) scored.set(fromConfig, Number.MAX_SAFE_INTEGER);
    }
  }

  const agentsDir = join(getOpenClawConfigDir(), 'agents');
  const agentDirs = await readdir(agentsDir, { withFileTypes: true }).catch(() => []);
  for (const dirent of agentDirs) {
    if (!dirent.isDirectory()) continue;
    const sessionEntries = await readSessionStoreEntries(dirent.name);
    for (const candidate of sessionEntries) {
      const normalizedSessionKey = stripThreadSuffixFromSessionKey(candidate.sessionKey);
      const route = inferDeliveryFromSessionKey(normalizedSessionKey);
      if (!route?.channel || route.channel !== storedChannelType) continue;

      const origin = isRecord(candidate.entry.origin) ? candidate.entry.origin : undefined;
      const accountId = normalizeString(origin?.accountId) || normalizeString(candidate.entry.lastAccountId);
      if (targetAccountId && accountId !== targetAccountId) continue;

      const to = normalizeString(origin?.to) || route.to;
      if (!to) continue;

      const updatedAtRaw = candidate.entry.updatedAt;
      let updatedAt = 0;
      if (typeof updatedAtRaw === 'number' && Number.isFinite(updatedAtRaw)) {
        updatedAt = updatedAtRaw < 1e12 ? updatedAtRaw * 1000 : updatedAtRaw;
      } else if (typeof updatedAtRaw === 'string') {
        const parsed = Date.parse(updatedAtRaw);
        if (Number.isFinite(parsed)) updatedAt = parsed;
      }

      scored.set(to, Math.max(scored.get(to) ?? 0, updatedAt));
    }
  }

  return Array.from(scored.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, maxItems)
    .map(([recipientId]) => recipientId);
}

function normalizePairingMeta(meta: unknown): Record<string, string> | undefined {
  if (!isRecord(meta)) return undefined;
  const entries = Object.entries(meta)
    .map(([key, value]) => [key, normalizeString(value)] as const)
    .filter(([, value]) => Boolean(value)) as Array<[string, string]>;
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function resolvePairingUserId(id: string, meta?: Record<string, string>): string {
  const fromMeta =
    meta?.userId
    || meta?.user_id
    || meta?.openId
    || meta?.open_id
    || meta?.unionId
    || meta?.union_id
    || meta?.senderId
    || meta?.sender_id;
  return normalizeString(fromMeta) || id;
}

function resolveTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function listChannelPairingRequestsFromOpenClaw(params: {
  channelType: string;
  accountId?: string;
  limit?: number;
}): Promise<ChannelPairingRequestView[]> {
  const storedChannelType = resolveStoredChannelType(params.channelType);
  const normalizedAccountId = normalizeString(params.accountId)?.toLowerCase();
  const maxItems = Math.max(1, Math.min(params.limit ?? 50, 200));
  const storePath = join(getOpenClawConfigDir(), 'credentials', `${storedChannelType}-pairing.json`);
  const raw = await readFile(storePath, 'utf8').catch(() => '');
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.requests)) {
    return [];
  }

  const requests: ChannelPairingRequestView[] = [];
  for (const entry of parsed.requests) {
    if (!isRecord(entry)) continue;
    const id = normalizeString(entry.id);
    const code = normalizeString(entry.code);
    const createdAt = normalizeString(entry.createdAt);
    if (!id || !code || !createdAt) continue;

    const meta = normalizePairingMeta(entry.meta);
    const accountId = normalizeString(meta?.accountId);
    if (normalizedAccountId && accountId?.toLowerCase() !== normalizedAccountId) {
      continue;
    }

    requests.push({
      id,
      userId: resolvePairingUserId(id, meta),
      code,
      createdAt,
      ...(normalizeString(entry.lastSeenAt) ? { lastSeenAt: normalizeString(entry.lastSeenAt) } : {}),
      ...(accountId ? { accountId } : {}),
      ...(meta ? { meta } : {}),
    });
  }

  return requests
    .sort((left, right) => resolveTimestamp(right.createdAt) - resolveTimestamp(left.createdAt))
    .slice(0, maxItems);
}

interface WebLoginStartResult {
  qrcodeUrl?: string;
  message?: string;
  sessionKey?: string;
}

function resolveStoredChannelType(channelType: string): string {
  return toOpenClawChannelType(channelType);
}

function buildQrLoginKey(channelType: string, accountId?: string): string {
  return `${toUiChannelType(channelType)}:${accountId?.trim() || '__new__'}`;
}

function setActiveQrLogin(channelType: string, sessionKey: string, accountId?: string): string {
  const loginKey = buildQrLoginKey(channelType, accountId);
  activeQrLogins.set(loginKey, sessionKey);
  return loginKey;
}

function isActiveQrLogin(loginKey: string, sessionKey: string): boolean {
  return activeQrLogins.get(loginKey) === sessionKey;
}

function clearActiveQrLogin(channelType: string, accountId?: string): void {
  activeQrLogins.delete(buildQrLoginKey(channelType, accountId));
}

function emitChannelEvent(
  ctx: HostApiContext,
  channelType: string,
  event: 'qr' | 'success' | 'error',
  payload: unknown,
): void {
  const eventName = buildQrChannelEventName(channelType, event);
  ctx.eventBus.emit(eventName, payload);
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send(eventName, payload);
  }
}

async function startWeChatQrLogin(ctx: HostApiContext, accountId?: string): Promise<WebLoginStartResult> {
  void ctx;
  return await startWeChatLoginSession({
    ...(accountId ? { accountId } : {}),
    force: true,
  });
}

async function awaitWeChatQrLogin(
  ctx: HostApiContext,
  sessionKey: string,
  loginKey: string,
): Promise<void> {
  try {
    const result = await waitForWeChatLoginSession({
      sessionKey,
      timeoutMs: WECHAT_QR_TIMEOUT_MS,
      onQrRefresh: async ({ qrcodeUrl }) => {
        if (!isActiveQrLogin(loginKey, sessionKey)) {
          return;
        }
        emitChannelEvent(ctx, UI_WECHAT_CHANNEL_TYPE, 'qr', {
          qr: qrcodeUrl,
          raw: qrcodeUrl,
          sessionKey,
        });
      },
    });

    if (!isActiveQrLogin(loginKey, sessionKey)) {
      return;
    }

    if (!result.connected || !result.accountId || !result.botToken) {
      emitChannelEvent(ctx, UI_WECHAT_CHANNEL_TYPE, 'error', result.message || 'WeChat login did not complete');
      return;
    }

    const normalizedAccountId = await saveWeChatAccountState(result.accountId, {
      token: result.botToken,
      baseUrl: result.baseUrl,
      userId: result.userId,
    });
    await saveChannelConfig(UI_WECHAT_CHANNEL_TYPE, { enabled: true }, normalizedAccountId);
    await ensureScopedChannelBinding(UI_WECHAT_CHANNEL_TYPE, normalizedAccountId);
    scheduleGatewayChannelSaveRefresh(ctx, OPENCLAW_WECHAT_CHANNEL_TYPE, `wechat:loginSuccess:${normalizedAccountId}`);

    if (!isActiveQrLogin(loginKey, sessionKey)) {
      return;
    }

    emitChannelEvent(ctx, UI_WECHAT_CHANNEL_TYPE, 'success', {
      accountId: normalizedAccountId,
      rawAccountId: result.accountId,
      message: result.message,
    });
  } catch (error) {
    if (!isActiveQrLogin(loginKey, sessionKey)) {
      return;
    }
    emitChannelEvent(ctx, UI_WECHAT_CHANNEL_TYPE, 'error', String(error));
  } finally {
    if (isActiveQrLogin(loginKey, sessionKey)) {
      activeQrLogins.delete(loginKey);
    }
    await cancelWeChatLoginSession(sessionKey);
  }
}

function scheduleGatewayChannelRestart(ctx: HostApiContext, reason: string): void {
  if (ctx.gatewayManager.getStatus().state === 'stopped') {
    return;
  }
  ctx.gatewayManager.debouncedRestart();
  void reason;
}

// Plugin-based channels require a full Gateway process restart to properly
// initialize / tear-down plugin connections.  SIGUSR1 in-process reload is
// not sufficient for channel plugins (see restartGatewayForAgentDeletion).
const FORCE_RESTART_CHANNELS = new Set(['dingtalk', 'wecom', 'whatsapp', 'feishu', 'qqbot', OPENCLAW_WECHAT_CHANNEL_TYPE]);

function scheduleGatewayChannelSaveRefresh(
  ctx: HostApiContext,
  channelType: string,
  reason: string,
): void {
  const storedChannelType = resolveStoredChannelType(channelType);
  if (ctx.gatewayManager.getStatus().state === 'stopped') {
    return;
  }
  if (FORCE_RESTART_CHANNELS.has(storedChannelType)) {
    ctx.gatewayManager.debouncedRestart();
    void reason;
    return;
  }
  ctx.gatewayManager.debouncedReload();
  void reason;
}

function toComparableConfig(input: Record<string, unknown>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      next[key] = value.trim();
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      next[key] = String(value);
    }
  }
  return next;
}

function isSameConfigValues(
  existing: Record<string, string> | undefined,
  incoming: Record<string, unknown>,
): boolean {
  if (!existing) return false;
  const next = toComparableConfig(incoming);
  const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
  if (keys.size === 0) return false;
  for (const key of keys) {
    if ((existing[key] ?? '') !== (next[key] ?? '')) {
      return false;
    }
  }
  return true;
}

async function ensureScopedChannelBinding(channelType: string, accountId?: string): Promise<void> {
  const storedChannelType = resolveStoredChannelType(channelType);
  // Multi-agent safety: only bind when the caller explicitly scopes the account.
  // Global channel saves (no accountId) must not override routing to "main".
  if (!accountId) return;
  const agents = await listAgentsSnapshot();
  if (!agents.agents || agents.agents.length === 0) return;

  // Keep backward compatibility for the legacy default account.
  if (accountId === 'default') {
    if (agents.agents.some((entry) => entry.id === 'main')) {
      await assignChannelAccountToAgent('main', storedChannelType, 'default');
    }
    return;
  }

  // Legacy compatibility: if accountId matches an existing agentId, keep auto-binding.
  if (agents.agents.some((entry) => entry.id === accountId)) {
    await assignChannelAccountToAgent(accountId, storedChannelType, accountId);
  }
}

interface GatewayChannelStatusPayload {
  channelOrder?: string[];
  channels?: Record<string, unknown>;
  channelAccounts?: Record<string, Array<{
    accountId?: string;
    configured?: boolean;
    connected?: boolean;
    running?: boolean;
    lastError?: string;
    name?: string;
    linked?: boolean;
    lastConnectedAt?: number | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
    lastProbeAt?: number | null;
    probe?: {
      ok?: boolean;
    } | null;
  }>>;
  channelDefaultAccountId?: Record<string, string>;
}

interface ChannelAccountView {
  accountId: string;
  name: string;
  configured: boolean;
  connected: boolean;
  running: boolean;
  linked: boolean;
  lastError?: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  isDefault: boolean;
  agentId?: string;
  defaultRecipientId?: string;
}

interface ChannelAccountsView {
  channelType: string;
  defaultAccountId: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  accounts: ChannelAccountView[];
}

interface ChannelAccountsCacheEntry {
  timestampMs: number;
  channels: ChannelAccountsView[];
}

const CHANNEL_ACCOUNTS_CACHE_TTL_MS = 5000;
let channelAccountsCache: ChannelAccountsCacheEntry | null = null;

function clearChannelAccountsCache(): void {
  channelAccountsCache = null;
}

async function buildChannelAccountsView(ctx: HostApiContext, options?: { probe?: boolean }): Promise<ChannelAccountsView[]> {
  const [configuredChannels, configuredAccounts, openClawConfig, agentsSnapshot] = await Promise.all([
    listConfiguredChannels(),
    listConfiguredChannelAccounts(),
    readOpenClawConfig(),
    listAgentsSnapshot(),
  ]);

  let gatewayStatus: GatewayChannelStatusPayload | null;
  try {
    gatewayStatus = await ctx.gatewayManager.rpc<GatewayChannelStatusPayload>('channels.status', { probe: options?.probe === true });
  } catch {
    gatewayStatus = null;
  }

  const channelTypes = new Set<string>([
    ...configuredChannels,
    ...Object.keys(configuredAccounts),
    ...Object.keys(gatewayStatus?.channelAccounts || {}),
  ]);

  const channels: ChannelAccountsView[] = [];
  for (const rawChannelType of channelTypes) {
    const uiChannelType = toUiChannelType(rawChannelType);
    const channelAccountsFromConfig = configuredAccounts[rawChannelType]?.accountIds ?? [];
    const hasLocalConfig = configuredChannels.includes(rawChannelType) || Boolean(configuredAccounts[rawChannelType]);
    const channelSection = openClawConfig.channels?.[rawChannelType];
    const channelSummary =
      (gatewayStatus?.channels?.[rawChannelType] as { error?: string; lastError?: string } | undefined) ?? undefined;
    const sortedConfigAccountIds = [...channelAccountsFromConfig].sort((left, right) => {
      if (left === 'default') return -1;
      if (right === 'default') return 1;
      return left.localeCompare(right);
    });
    const fallbackDefault =
      typeof channelSection?.defaultAccount === 'string' && channelSection.defaultAccount.trim()
        ? channelSection.defaultAccount
        : (sortedConfigAccountIds[0] || 'default');
    const defaultAccountId = configuredAccounts[rawChannelType]?.defaultAccountId
      ?? gatewayStatus?.channelDefaultAccountId?.[rawChannelType]
      ?? fallbackDefault;
    const runtimeAccounts = gatewayStatus?.channelAccounts?.[rawChannelType] ?? [];
    const hasRuntimeConfigured = runtimeAccounts.some((account) => account.configured === true);
    if (!hasLocalConfig && !hasRuntimeConfigured) {
      continue;
    }
    const runtimeAccountIds = runtimeAccounts
      .map((account) => account.accountId)
      .filter((accountId): accountId is string => typeof accountId === 'string' && accountId.trim().length > 0);
    const accountIds = Array.from(new Set([...channelAccountsFromConfig, ...runtimeAccountIds, defaultAccountId]));

    const accounts: ChannelAccountView[] = accountIds.map((accountId) => {
      const runtime = runtimeAccounts.find((item) => item.accountId === accountId);
      const runtimeSnapshot: ChannelRuntimeAccountSnapshot = runtime ?? {};
      const status = computeChannelRuntimeStatus(runtimeSnapshot);
      const accountConfig =
        (channelSection?.accounts && typeof channelSection.accounts === 'object'
          ? (channelSection.accounts as Record<string, Record<string, unknown>>)[accountId]
          : undefined) ?? undefined;
      const defaultRecipientId =
        normalizeString(accountConfig?.defaultRecipientId)
        || normalizeString(accountConfig?.deliveryTo)
        || normalizeString(accountConfig?.to);
      return {
        accountId,
        name: runtime?.name || accountId,
        configured: channelAccountsFromConfig.includes(accountId) || runtime?.configured === true,
        connected: runtime?.connected === true,
        running: runtime?.running === true,
        linked: runtime?.linked === true,
        lastError: typeof runtime?.lastError === 'string' ? runtime.lastError : undefined,
        status,
        isDefault: accountId === defaultAccountId,
        agentId: agentsSnapshot.channelAccountOwners[`${rawChannelType}:${accountId}`],
        ...(defaultRecipientId ? { defaultRecipientId } : {}),
      };
    }).sort((left, right) => {
      if (left.accountId === defaultAccountId) return -1;
      if (right.accountId === defaultAccountId) return 1;
      return left.accountId.localeCompare(right.accountId);
    });

    channels.push({
      channelType: uiChannelType,
      defaultAccountId,
      status: pickChannelRuntimeStatus(runtimeAccounts, channelSummary),
      accounts,
    });
  }

  return channels.sort((left, right) => left.channelType.localeCompare(right.channelType));
}

export async function handleChannelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/channels/configured' && req.method === 'GET') {
    const channels = await listConfiguredChannels();
    sendJson(res, 200, { success: true, channels: Array.from(new Set(channels.map((channel) => toUiChannelType(channel)))) });
    return true;
  }

  if (url.pathname === '/api/channels/accounts' && req.method === 'GET') {
    try {
      const probe = url.searchParams.get('probe') === '1';
      const force = url.searchParams.get('force') === '1';
      const now = Date.now();
      if (!probe && !force && channelAccountsCache && (now - channelAccountsCache.timestampMs) < CHANNEL_ACCOUNTS_CACHE_TTL_MS) {
        sendJson(res, 200, { success: true, channels: channelAccountsCache.channels });
        return true;
      }
      const channels = await buildChannelAccountsView(ctx, { probe });
      if (!probe) {
        channelAccountsCache = { timestampMs: now, channels };
      }
      sendJson(res, 200, { success: true, channels });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/recipient-options' && req.method === 'GET') {
    try {
      const channelType = url.searchParams.get('channelType')?.trim() || '';
      const accountId = url.searchParams.get('accountId')?.trim() || '';
      const limit = Number(url.searchParams.get('limit') || '50');
      if (!channelType) {
        sendJson(res, 400, { success: false, error: 'channelType is required' });
        return true;
      }
      const recipients = await listRecipientCandidatesFromOpenClaw({
        channelType,
        accountId: accountId || undefined,
        limit: Number.isFinite(limit) ? limit : 50,
      });
      sendJson(res, 200, { success: true, recipients });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/pairing-requests' && req.method === 'GET') {
    try {
      const channelType = url.searchParams.get('channelType')?.trim() || '';
      const accountId = url.searchParams.get('accountId')?.trim() || '';
      const limit = Number(url.searchParams.get('limit') || '50');
      if (!channelType) {
        sendJson(res, 400, { success: false, error: 'channelType is required' });
        return true;
      }
      const requests = await listChannelPairingRequestsFromOpenClaw({
        channelType,
        accountId: accountId || undefined,
        limit: Number.isFinite(limit) ? limit : 50,
      });
      sendJson(res, 200, { success: true, requests });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/default-account' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{ channelType: string; accountId: string }>(req);
      await setChannelDefaultAccount(body.channelType, body.accountId);
      clearChannelAccountsCache();
      scheduleGatewayChannelSaveRefresh(ctx, body.channelType, `channel:setDefaultAccount:${body.channelType}`);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/binding' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{ channelType: string; accountId: string; agentId: string }>(req);
      await assignChannelAccountToAgent(body.agentId, resolveStoredChannelType(body.channelType), body.accountId);
      clearChannelAccountsCache();
      scheduleGatewayChannelSaveRefresh(ctx, body.channelType, `channel:setBinding:${body.channelType}`);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/binding' && req.method === 'DELETE') {
    try {
      const body = await parseJsonBody<{ channelType: string; accountId: string }>(req);
      await clearChannelBinding(resolveStoredChannelType(body.channelType), body.accountId);
      clearChannelAccountsCache();
      scheduleGatewayChannelSaveRefresh(ctx, body.channelType, `channel:clearBinding:${body.channelType}`);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/config/validate' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ channelType: string }>(req);
      sendJson(res, 200, { success: true, ...(await validateChannelConfig(body.channelType)) });
    } catch (error) {
      sendJson(res, 500, { success: false, valid: false, errors: [String(error)], warnings: [] });
    }
    return true;
  }

  if (url.pathname === '/api/channels/credentials/validate' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ channelType: string; config: Record<string, string> }>(req);
      sendJson(res, 200, { success: true, ...(await validateChannelCredentials(body.channelType, body.config)) });
    } catch (error) {
      sendJson(res, 500, { success: false, valid: false, errors: [String(error)], warnings: [] });
    }
    return true;
  }

  if (url.pathname === '/api/channels/whatsapp/start' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ accountId: string }>(req);
      await whatsAppLoginManager.start(body.accountId);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/whatsapp/cancel' && req.method === 'POST') {
    try {
      await whatsAppLoginManager.stop();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/wechat/start' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ accountId?: string }>(req);
      const requestedAccountId = body.accountId?.trim() || undefined;

      const installResult = await ensureWeChatPluginInstalled();
      if (!installResult.installed) {
        sendJson(res, 500, { success: false, error: installResult.warning || 'WeChat plugin install failed' });
        return true;
      }

      await cleanupDanglingWeChatPluginState();
      const startResult = await startWeChatQrLogin(ctx, requestedAccountId);
      if (!startResult.qrcodeUrl || !startResult.sessionKey) {
        throw new Error(startResult.message || 'Failed to generate WeChat QR code');
      }

      const loginKey = setActiveQrLogin(UI_WECHAT_CHANNEL_TYPE, startResult.sessionKey, requestedAccountId);
      emitChannelEvent(ctx, UI_WECHAT_CHANNEL_TYPE, 'qr', {
        qr: startResult.qrcodeUrl,
        raw: startResult.qrcodeUrl,
        sessionKey: startResult.sessionKey,
      });
      void awaitWeChatQrLogin(ctx, startResult.sessionKey, loginKey);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/wechat/cancel' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ accountId?: string }>(req);
      const accountId = body.accountId?.trim() || undefined;
      const loginKey = buildQrLoginKey(UI_WECHAT_CHANNEL_TYPE, accountId);
      const sessionKey = activeQrLogins.get(loginKey);
      clearActiveQrLogin(UI_WECHAT_CHANNEL_TYPE, accountId);
      if (sessionKey) {
        await cancelWeChatLoginSession(sessionKey);
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/config' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ channelType: string; config: Record<string, unknown>; accountId?: string }>(req);
      const storedChannelType = resolveStoredChannelType(body.channelType);
      if (storedChannelType === 'dingtalk') {
        const installResult = await ensureDingTalkPluginInstalled();
        if (!installResult.installed) {
          sendJson(res, 500, { success: false, error: installResult.warning || 'DingTalk plugin install failed' });
          return true;
        }
      }
      if (storedChannelType === 'wecom') {
        const installResult = await ensureWeComPluginInstalled();
        if (!installResult.installed) {
          sendJson(res, 500, { success: false, error: installResult.warning || 'WeCom plugin install failed' });
          return true;
        }
      }
      if (storedChannelType === 'qqbot') {
        const installResult = await ensureQQBotPluginInstalled();
        if (!installResult.installed) {
          sendJson(res, 500, { success: false, error: installResult.warning || 'QQ Bot plugin install failed' });
          return true;
        }
      }
      if (storedChannelType === 'feishu') {
        const installResult = await ensureFeishuPluginInstalled();
        if (!installResult.installed) {
          sendJson(res, 500, { success: false, error: installResult.warning || 'Feishu plugin install failed' });
          return true;
        }
      }
      if (storedChannelType === OPENCLAW_WECHAT_CHANNEL_TYPE) {
        const installResult = await ensureWeChatPluginInstalled();
        if (!installResult.installed) {
          sendJson(res, 500, { success: false, error: installResult.warning || 'WeChat plugin install failed' });
          return true;
        }
      }
      const existingValues = await getChannelFormValues(body.channelType, body.accountId);
      if (isSameConfigValues(existingValues, body.config)) {
        await ensureScopedChannelBinding(body.channelType, body.accountId);
        sendJson(res, 200, { success: true, noChange: true });
        return true;
      }
      await saveChannelConfig(body.channelType, body.config, body.accountId);
      await ensureScopedChannelBinding(body.channelType, body.accountId);
      clearChannelAccountsCache();
      scheduleGatewayChannelSaveRefresh(ctx, storedChannelType, `channel:saveConfig:${storedChannelType}`);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/config/enabled' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{ channelType: string; enabled: boolean }>(req);
      await setChannelEnabled(body.channelType, body.enabled);
      clearChannelAccountsCache();
      scheduleGatewayChannelRestart(ctx, `channel:setEnabled:${resolveStoredChannelType(body.channelType)}`);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/channels/config/') && req.method === 'GET') {
    try {
      const channelType = decodeURIComponent(url.pathname.slice('/api/channels/config/'.length));
      const accountId = url.searchParams.get('accountId') || undefined;
      sendJson(res, 200, {
        success: true,
        values: await getChannelFormValues(channelType, accountId),
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/channels/config/') && req.method === 'DELETE') {
    try {
      const channelType = decodeURIComponent(url.pathname.slice('/api/channels/config/'.length));
      const accountId = url.searchParams.get('accountId') || undefined;
      const storedChannelType = resolveStoredChannelType(channelType);
      if (accountId) {
        await deleteChannelAccountConfig(channelType, accountId);
        await clearChannelBinding(storedChannelType, accountId);
        clearChannelAccountsCache();
        scheduleGatewayChannelSaveRefresh(ctx, storedChannelType, `channel:deleteAccount:${storedChannelType}`);
      } else {
        await deleteChannelConfig(channelType);
        await clearAllBindingsForChannel(storedChannelType);
        clearChannelAccountsCache();
        scheduleGatewayChannelRestart(ctx, `channel:deleteConfig:${storedChannelType}`);
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  void ctx;
  return false;
}
