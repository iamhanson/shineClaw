import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'node:path';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { getOpenClawConfigDir } from '../../utils/paths';
import { listConfiguredChannelAccounts, readOpenClawConfig } from '../../utils/channel-config';
import { toOpenClawChannelType, toUiChannelType } from '../../utils/channel-alias';

interface GatewayCronJob {
  id: string;
  agentId?: string;
  sessionKey?: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: { kind: string; expr?: string; everyMs?: number; at?: string; tz?: string };
  payload: { kind: string; message?: string; text?: string };
  delivery?: { mode: string; channel?: string; to?: string; accountId?: string; bestEffort?: boolean };
  sessionTarget?: string;
  state: {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
  };
}

interface CronRunLogEntry {
  jobId?: string;
  action?: string;
  status?: string;
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  ts?: number;
  runAtMs?: number;
  durationMs?: number;
  model?: string;
  provider?: string;
}

interface CronSessionKeyParts {
  agentId: string;
  jobId: string;
  runSessionId?: string;
}

interface CronSessionFallbackMessage {
  id: string;
  role: 'assistant' | 'system';
  content: string;
  timestamp: number;
  isError?: boolean;
}

interface SessionStoreCandidate {
  sessionKey: string;
  entry: Record<string, unknown>;
}

interface ResolvedCronDeliveryRoute {
  sessionKey: string;
  delivery: {
    mode: 'announce';
    channel: string;
    to: string;
    accountId?: string;
    bestEffort: boolean;
  };
}

interface CronChannelOptionAccountView {
  accountId: string;
  name: string;
  configured: boolean;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  isDefault: boolean;
  agentId?: string;
  defaultRecipientId?: string;
  recipientOptions?: string[];
}

interface CronChannelOptionView {
  channelType: string;
  defaultAccountId: string;
  accounts: CronChannelOptionAccountView[];
}

type CronJobDeliverySnapshot = Pick<GatewayCronJob, 'sessionKey' | 'delivery'>;
type CronDeliveryPatchState = {
  delivery: {
    mode: 'announce';
    channel: string;
    to?: string | null;
    accountId?: string | null;
    bestEffort: boolean;
  };
  sessionKey: string | null;
};

function parseCronSessionKey(sessionKey: string): CronSessionKeyParts | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 4 || parts[2] !== 'cron') return null;

  const agentId = parts[1] || 'main';
  const jobId = parts[3];
  if (!jobId) return null;

  if (parts.length === 4) {
    return { agentId, jobId };
  }

  if (parts.length === 6 && parts[4] === 'run' && parts[5]) {
    return { agentId, jobId, runSessionId: parts[5] };
  }

  return null;
}

function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveConfiguredDefaultRecipientId(accountConfig: Record<string, unknown> | undefined): string | undefined {
  if (!accountConfig) return undefined;
  return normalizeString(accountConfig.defaultRecipientId)
    || normalizeString(accountConfig.deliveryTo)
    || normalizeString(accountConfig.to);
}

function resolveConfiguredRecipientOptions(accountConfig: Record<string, unknown> | undefined): string[] {
  if (!accountConfig) return [];
  const raw = accountConfig.allowFrom;
  const values = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(',') : []);

  const normalized = values
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item) && item !== '*');

  return Array.from(new Set(normalized));
}

function buildChannelAccountOwnerMapFromConfig(bindings: unknown): Record<string, string> {
  if (!Array.isArray(bindings)) return {};
  const ownerByChannelAccount: Record<string, string> = {};
  for (const binding of bindings) {
    if (!isRecord(binding)) continue;
    const agentId = normalizeString(binding.agentId);
    const match = isRecord(binding.match) ? binding.match : undefined;
    const rawChannel = normalizeString(match?.channel);
    const accountId = normalizeString(match?.accountId) || 'default';
    if (!agentId || !rawChannel) continue;
    const channelType = toOpenClawChannelType(rawChannel);
    ownerByChannelAccount[`${channelType}:${accountId}`] = agentId;
  }
  return ownerByChannelAccount;
}

async function buildCronChannelOptionsFromOpenClawConfig(): Promise<CronChannelOptionView[]> {
  const configuredAccounts = await listConfiguredChannelAccounts().catch(() => ({}));
  const openClawConfig = await readOpenClawConfig().catch(() => ({ channels: {}, bindings: [] } as Record<string, unknown>));
  const channels = isRecord(openClawConfig.channels) ? openClawConfig.channels : {};
  const ownerByChannelAccount = buildChannelAccountOwnerMapFromConfig(
    isRecord(openClawConfig) ? openClawConfig.bindings : undefined,
  );

  const result: CronChannelOptionView[] = [];

  for (const [storedChannelType, configured] of Object.entries(configuredAccounts)) {
    const defaultAccountId = normalizeString(configured.defaultAccountId) || 'default';
    const accountIds = Array.isArray(configured.accountIds)
      ? configured.accountIds.filter((item) => typeof item === 'string' && item.trim())
      : [];
    if (accountIds.length === 0) continue;

    const channelSection = isRecord(channels[storedChannelType]) ? channels[storedChannelType] : {};
    const rawAccounts = isRecord(channelSection.accounts) ? channelSection.accounts : {};

    const accounts: CronChannelOptionAccountView[] = accountIds.map((accountId) => {
      const accountConfig = isRecord(rawAccounts[accountId]) ? rawAccounts[accountId] : undefined;
      const fallbackConfig = accountId === 'default' && !accountConfig ? channelSection : undefined;
      const mergedConfig = accountConfig || fallbackConfig;
      const defaultRecipientId = resolveConfiguredDefaultRecipientId(mergedConfig);
      const recipientOptions = resolveConfiguredRecipientOptions(mergedConfig);
      return {
        accountId,
        name: normalizeString(mergedConfig?.name) || accountId,
        configured: true,
        status: 'connected',
        isDefault: accountId === defaultAccountId,
        agentId: ownerByChannelAccount[`${storedChannelType}:${accountId}`],
        ...(defaultRecipientId ? { defaultRecipientId } : {}),
        ...(recipientOptions.length > 0 ? { recipientOptions } : {}),
      };
    });

    result.push({
      channelType: toUiChannelType(storedChannelType),
      defaultAccountId,
      accounts,
    });
  }

  return result.sort((left, right) => left.channelType.localeCompare(right.channelType));
}

function stripThreadSuffixFromSessionKey(sessionKey: string): string {
  const idx = sessionKey.toLowerCase().lastIndexOf(':thread:');
  if (idx <= 0) return sessionKey;
  const parentKey = sessionKey.slice(0, idx).trim();
  return parentKey || sessionKey;
}

function parseAgentSessionKey(sessionKey: string): { agentId: string; rest: string } | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 3) return null;
  const agentId = parts[1]?.trim() || 'main';
  const rest = parts.slice(2).join(':').trim();
  if (!rest) return null;
  return { agentId, rest };
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

export function buildFallbackChannelDeliveryStateForUpdate(params: {
  targetChannelType: string;
  previousJob?: CronJobDeliverySnapshot;
  bestEffort: boolean;
  preferredAccountId?: string;
  preferredRecipientId?: string;
}): CronDeliveryPatchState {
  const storedChannelType = toOpenClawChannelType(params.targetChannelType);
  const preferredAccountId = normalizeString(params.preferredAccountId);
  const preferredRecipientId = normalizeString(params.preferredRecipientId);

  if (preferredRecipientId) {
    return {
      delivery: {
        mode: 'announce',
        channel: storedChannelType,
        to: preferredRecipientId,
        ...(preferredAccountId ? { accountId: preferredAccountId } : {}),
        bestEffort: params.bestEffort,
      },
      sessionKey: null,
    };
  }

  const previousDelivery = params.previousJob?.delivery;
  const previousSessionKey = normalizeString(params.previousJob?.sessionKey);
  const previousSessionRoute = previousSessionKey
    ? inferDeliveryFromSessionKey(previousSessionKey)
    : null;
  const previousAccountId = normalizeString(previousDelivery?.accountId);
  const sessionChannelMatches = previousSessionRoute?.channel === storedChannelType;
  const explicitDeliveryMatches =
    !previousSessionKey &&
    previousDelivery?.channel === storedChannelType &&
    typeof previousDelivery?.to === 'string' &&
    previousDelivery.to.trim().length > 0;

  const accountMatchesPreference =
    !preferredAccountId
    || (previousAccountId === preferredAccountId);
  const canReusePriorTarget = (sessionChannelMatches || explicitDeliveryMatches) && accountMatchesPreference;

  return {
    delivery: {
      mode: 'announce',
      channel: storedChannelType,
      ...(canReusePriorTarget
        ? {
          ...(typeof previousDelivery?.to === 'string' && previousDelivery.to.trim()
            ? { to: previousDelivery.to.trim() }
            : {}),
          ...(typeof previousDelivery?.accountId === 'string' && previousDelivery.accountId.trim()
            ? { accountId: previousDelivery.accountId.trim() }
            : {}),
        }
        : {
          to: null,
          accountId: preferredAccountId ?? null,
        }),
      bestEffort: params.bestEffort,
    },
    sessionKey: canReusePriorTarget && previousSessionKey ? previousSessionKey : null,
  };
}

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

function getGatewayCronJobAgentId(job?: Pick<GatewayCronJob, 'agentId' | 'sessionTarget'>): string {
  if (typeof job?.agentId === 'string' && job.agentId.trim()) return job.agentId.trim();
  if (job?.sessionTarget && job.sessionTarget !== 'main' && job.sessionTarget !== 'isolated') {
    return job.sessionTarget;
  }
  return 'main';
}

function buildRouteDeliveryFromSession(params: {
  channelType: string;
  sessionKey: string;
  entry: Record<string, unknown>;
  bestEffort?: boolean;
}): ResolvedCronDeliveryRoute | null {
  const inferred = inferDeliveryFromSessionKey(params.sessionKey);
  if (!inferred?.to) return null;

  const origin = isRecord(params.entry.origin) ? params.entry.origin : undefined;
  const to = normalizeString(origin?.to) || inferred.to;
  if (!to) return null;

  const accountId = normalizeString(origin?.accountId) || normalizeString(params.entry.lastAccountId);
  return {
    sessionKey: stripThreadSuffixFromSessionKey(params.sessionKey),
    delivery: {
      mode: 'announce',
      channel: params.channelType,
      to,
      ...(accountId ? { accountId } : {}),
      bestEffort: params.bestEffort ?? true,
    },
  };
}

async function resolveCronDeliveryRoute(params: {
  agentId: string;
  channelType: string;
  previousSessionKey?: string;
  bestEffort?: boolean;
  preferredAccountId?: string;
  preferredRecipientId?: string;
}): Promise<ResolvedCronDeliveryRoute | null> {
  const storedChannelType = toOpenClawChannelType(params.channelType);
  const configuredAccounts = await listConfiguredChannelAccounts().catch(() => ({}));
  const preferredAccountId = normalizeString(params.preferredAccountId)
    || configuredAccounts[storedChannelType]?.defaultAccountId;
  const preferredRecipientId = normalizeString(params.preferredRecipientId);
  const previousSessionKey = normalizeString(params.previousSessionKey)
    ? stripThreadSuffixFromSessionKey(params.previousSessionKey as string)
    : undefined;

  if (preferredRecipientId) {
    if (!previousSessionKey) {
      return null;
    }
    return {
      sessionKey: previousSessionKey,
      delivery: {
        mode: 'announce',
        channel: storedChannelType,
        to: preferredRecipientId,
        ...(preferredAccountId ? { accountId: preferredAccountId } : {}),
        bestEffort: params.bestEffort ?? true,
      },
    };
  }

  const candidates = await readSessionStoreEntries(params.agentId);
  const ranked = candidates
    .map((candidate) => {
      const normalizedSessionKey = stripThreadSuffixFromSessionKey(candidate.sessionKey);
      const route = inferDeliveryFromSessionKey(normalizedSessionKey);
      if (!route?.channel || route.channel !== storedChannelType) return null;

      const deliveryRoute = buildRouteDeliveryFromSession({
        channelType: storedChannelType,
        sessionKey: normalizedSessionKey,
        entry: candidate.entry,
        bestEffort: params.bestEffort,
      });
      if (!deliveryRoute) return null;

      const origin = isRecord(candidate.entry.origin) ? candidate.entry.origin : undefined;
      const accountId = normalizeString(origin?.accountId) || normalizeString(candidate.entry.lastAccountId);
      if (preferredAccountId && accountId !== preferredAccountId) {
        return null;
      }
      const updatedAt = normalizeTimestampMs(candidate.entry.updatedAt) ?? 0;
      const sameSession = previousSessionKey && previousSessionKey === normalizedSessionKey;
      const accountMatch = preferredAccountId && accountId === preferredAccountId;

      return {
        updatedAt,
        sameSession,
        accountMatch,
        route: deliveryRoute,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => {
      if (left.sameSession !== right.sameSession) return left.sameSession ? -1 : 1;
      if (left.accountMatch !== right.accountMatch) return left.accountMatch ? -1 : 1;
      return right.updatedAt - left.updatedAt;
    });

  return ranked[0]?.route ?? null;
}

function formatDuration(durationMs: number | undefined): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1000)}s`;
}

function buildCronRunMessage(entry: CronRunLogEntry, index: number): CronSessionFallbackMessage | null {
  const timestamp = normalizeTimestampMs(entry.ts) ?? normalizeTimestampMs(entry.runAtMs);
  if (!timestamp) return null;

  const status = typeof entry.status === 'string' ? entry.status.toLowerCase() : '';
  const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
  const error = typeof entry.error === 'string' ? entry.error.trim() : '';
  let content = summary || error;

  if (!content) {
    content = status === 'error'
      ? 'Scheduled task failed.'
      : 'Scheduled task completed.';
  }

  if (status === 'error' && !content.toLowerCase().startsWith('run failed:')) {
    content = `Run failed: ${content}`;
  }

  const meta: string[] = [];
  const duration = formatDuration(entry.durationMs);
  if (duration) meta.push(`Duration: ${duration}`);
  if (entry.provider && entry.model) {
    meta.push(`Model: ${entry.provider}/${entry.model}`);
  } else if (entry.model) {
    meta.push(`Model: ${entry.model}`);
  }
  if (meta.length > 0) {
    content = `${content}\n\n${meta.join(' | ')}`;
  }

  return {
    id: `cron-run-${entry.sessionId ?? entry.ts ?? index}`,
    role: status === 'error' ? 'system' : 'assistant',
    content,
    timestamp,
    ...(status === 'error' ? { isError: true } : {}),
  };
}

async function readCronRunLog(jobId: string): Promise<CronRunLogEntry[]> {
  const logPath = join(getOpenClawConfigDir(), 'cron', 'runs', `${jobId}.jsonl`);
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  if (!raw.trim()) return [];

  const entries: CronRunLogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as CronRunLogEntry;
      if (!entry || entry.jobId !== jobId) continue;
      if (entry.action && entry.action !== 'finished') continue;
      entries.push(entry);
    } catch {
      // Ignore malformed log lines so one bad entry does not hide the rest.
    }
  }
  return entries;
}

async function readSessionStoreEntry(
  agentId: string,
  sessionKey: string,
): Promise<Record<string, unknown> | undefined> {
  const storePath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', 'sessions.json');
  const raw = await readFile(storePath, 'utf8').catch(() => '');
  if (!raw.trim()) return undefined;

  try {
    const store = JSON.parse(raw) as Record<string, unknown>;
    const directEntry = store[sessionKey];
    if (directEntry && typeof directEntry === 'object') {
      return directEntry as Record<string, unknown>;
    }

    const sessions = (store as { sessions?: unknown }).sessions;
    if (Array.isArray(sessions)) {
      const arrayEntry = sessions.find((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const record = entry as Record<string, unknown>;
        return record.key === sessionKey || record.sessionKey === sessionKey;
      });
      if (arrayEntry && typeof arrayEntry === 'object') {
        return arrayEntry as Record<string, unknown>;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function buildCronSessionFallbackMessages(params: {
  sessionKey: string;
  job?: Pick<GatewayCronJob, 'name' | 'payload' | 'state'>;
  runs: CronRunLogEntry[];
  sessionEntry?: { label?: string; updatedAt?: number };
  limit?: number;
}): CronSessionFallbackMessage[] {
  const parsed = parseCronSessionKey(params.sessionKey);
  if (!parsed) return [];

  const matchingRuns = params.runs
    .filter((entry) => {
      if (!parsed.runSessionId) return true;
      return entry.sessionId === parsed.runSessionId
        || entry.sessionKey === `${params.sessionKey}`;
    })
    .sort((a, b) => {
      const left = normalizeTimestampMs(a.ts) ?? normalizeTimestampMs(a.runAtMs) ?? 0;
      const right = normalizeTimestampMs(b.ts) ?? normalizeTimestampMs(b.runAtMs) ?? 0;
      return left - right;
    });

  const messages: CronSessionFallbackMessage[] = [];
  const prompt = params.job?.payload?.message || params.job?.payload?.text || '';
  const taskName = params.job?.name?.trim()
    || params.sessionEntry?.label?.replace(/^Cron:\s*/, '').trim()
    || '';
  const firstRelevantTimestamp = matchingRuns.length > 0
    ? (normalizeTimestampMs(matchingRuns[0]?.runAtMs) ?? normalizeTimestampMs(matchingRuns[0]?.ts))
    : (normalizeTimestampMs(params.job?.state?.runningAtMs) ?? params.sessionEntry?.updatedAt);

  if (taskName || prompt) {
    const lines = [taskName ? `Scheduled task: ${taskName}` : 'Scheduled task'];
    if (prompt) lines.push(`Prompt: ${prompt}`);
    messages.push({
      id: `cron-meta-${parsed.jobId}`,
      role: 'system',
      content: lines.join('\n'),
      timestamp: Math.max(0, (firstRelevantTimestamp ?? Date.now()) - 1),
    });
  }

  matchingRuns.forEach((entry, index) => {
    const message = buildCronRunMessage(entry, index);
    if (message) messages.push(message);
  });

  if (matchingRuns.length === 0) {
    const runningAt = normalizeTimestampMs(params.job?.state?.runningAtMs);
    if (runningAt) {
      messages.push({
        id: `cron-running-${parsed.jobId}`,
        role: 'system',
        content: 'This scheduled task is still running in OpenClaw, but no chat transcript is available yet.',
        timestamp: runningAt,
      });
    } else if (messages.length === 0) {
      messages.push({
        id: `cron-empty-${parsed.jobId}`,
        role: 'system',
        content: 'No chat transcript is available for this scheduled task yet.',
        timestamp: params.sessionEntry?.updatedAt ?? Date.now(),
      });
    }
  }

  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
    ? Math.max(1, Math.floor(params.limit))
    : messages.length;
  return messages.slice(-limit);
}

function transformCronJob(job: GatewayCronJob) {
  const message = job.payload?.message || job.payload?.text || '';
  const channelType = job.delivery?.channel ? toUiChannelType(job.delivery.channel) : undefined;
  const target = channelType
    ? {
      channelType,
      channelId: channelType,
      channelName: channelType,
      ...(typeof job.delivery?.accountId === 'string' && job.delivery.accountId.trim()
        ? { accountId: job.delivery.accountId.trim() }
        : {}),
      ...(typeof job.delivery?.to === 'string' && job.delivery.to.trim()
        ? { recipientId: job.delivery.to.trim() }
        : {}),
    }
    : undefined;
  const lastRun = job.state?.lastRunAtMs
    ? {
      time: new Date(job.state.lastRunAtMs).toISOString(),
      success: job.state.lastStatus === 'ok',
      error: job.state.lastError,
      duration: job.state.lastDurationMs,
    }
    : undefined;
  const nextRun = job.state?.nextRunAtMs
    ? new Date(job.state.nextRunAtMs).toISOString()
    : undefined;

  return {
    id: job.id,
    name: job.name,
    message,
    schedule: job.schedule,
    agentId: getGatewayCronJobAgentId(job),
    target,
    enabled: job.enabled,
    createdAt: new Date(job.createdAtMs).toISOString(),
    updatedAt: new Date(job.updatedAtMs).toISOString(),
    lastRun,
    nextRun,
  };
}

export function buildIsolatedCronPayload(message: string): { kind: 'agentTurn'; message: string } {
  return {
    kind: 'agentTurn',
    message,
  };
}

async function findCronJobById(
  ctx: HostApiContext,
  id: string,
): Promise<GatewayCronJob | undefined> {
  const result = await ctx.gatewayManager.rpc('cron.list', { includeDisabled: true });
  const jobs = (result as { jobs?: GatewayCronJob[] })?.jobs ?? [];
  return jobs.find((job) => job.id === id);
}

export async function handleCronRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/cron/channel-options' && req.method === 'GET') {
    try {
      const channels = await buildCronChannelOptionsFromOpenClawConfig();
      sendJson(res, 200, { success: true, channels });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/cron/session-history' && req.method === 'GET') {
    const sessionKey = url.searchParams.get('sessionKey')?.trim() || '';
    const parsedSession = parseCronSessionKey(sessionKey);
    if (!parsedSession) {
      sendJson(res, 400, { success: false, error: `Invalid cron sessionKey: ${sessionKey}` });
      return true;
    }

    const rawLimit = Number(url.searchParams.get('limit') || '200');
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 1), 200)
      : 200;

    try {
      const [jobsResult, runs, sessionEntry] = await Promise.all([
        ctx.gatewayManager.rpc('cron.list', { includeDisabled: true })
          .catch(() => ({ jobs: [] as GatewayCronJob[] })),
        readCronRunLog(parsedSession.jobId),
        readSessionStoreEntry(parsedSession.agentId, sessionKey),
      ]);

      const jobs = (jobsResult as { jobs?: GatewayCronJob[] }).jobs ?? [];
      const job = jobs.find((item) => item.id === parsedSession.jobId);
      const messages = buildCronSessionFallbackMessages({
        sessionKey,
        job,
        runs,
        sessionEntry: sessionEntry ? {
          label: typeof sessionEntry.label === 'string' ? sessionEntry.label : undefined,
          updatedAt: normalizeTimestampMs(sessionEntry.updatedAt),
        } : undefined,
        limit,
      });

      sendJson(res, 200, { messages });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/cron/jobs' && req.method === 'GET') {
    try {
      const result = await ctx.gatewayManager.rpc('cron.list', { includeDisabled: true });
      const data = result as { jobs?: GatewayCronJob[] };
      const jobs = data?.jobs ?? [];
      for (const job of jobs) {
        const isIsolatedAgent =
          (job.sessionTarget === 'isolated' || !job.sessionTarget) &&
          job.payload?.kind === 'agentTurn';
        const needsRepair =
          isIsolatedAgent &&
          job.delivery?.mode === 'announce' &&
          !job.delivery?.channel;
        if (needsRepair) {
          try {
            await ctx.gatewayManager.rpc('cron.update', {
              id: job.id,
              patch: { delivery: { mode: 'none' } },
            });
            job.delivery = { mode: 'none' };
            if (job.state?.lastError?.includes('Channel is required')) {
              job.state.lastError = undefined;
              job.state.lastStatus = 'ok';
            }
          } catch {
            // ignore per-job repair failure
          }
        }
      }
      sendJson(res, 200, jobs.map(transformCronJob));
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/cron/jobs' && req.method === 'POST') {
    try {
      const input = await parseJsonBody<{
        name: string;
        message: string;
        schedule: string;
        agentId?: string;
        targetChannelType?: string;
        targetAccountId?: string;
        targetRecipientId?: string;
        enabled?: boolean;
      }>(req);
      const agentId = typeof input.agentId === 'string' && input.agentId.trim()
        ? input.agentId.trim()
        : 'main';
      const targetChannelType = typeof input.targetChannelType === 'string' && input.targetChannelType.trim()
        ? input.targetChannelType.trim()
        : '';
      const targetAccountId = typeof input.targetAccountId === 'string' && input.targetAccountId.trim()
        ? input.targetAccountId.trim()
        : '';
      const targetRecipientId = typeof input.targetRecipientId === 'string' && input.targetRecipientId.trim()
        ? input.targetRecipientId.trim()
        : '';
      const deliveryRoute = targetChannelType
        ? await resolveCronDeliveryRoute({
          agentId,
          channelType: targetChannelType,
          preferredAccountId: targetAccountId || undefined,
          preferredRecipientId: targetRecipientId || undefined,
        })
        : null;
      const fallbackDelivery = targetChannelType
        ? buildFallbackChannelDeliveryStateForUpdate({
          targetChannelType,
          bestEffort: true,
          preferredAccountId: targetAccountId || undefined,
          preferredRecipientId: targetRecipientId || undefined,
        })
        : null;
      const result = await ctx.gatewayManager.rpc('cron.add', {
        name: input.name,
        schedule: { kind: 'cron', expr: input.schedule },
        payload: buildIsolatedCronPayload(input.message),
        enabled: input.enabled ?? true,
        wakeMode: 'next-heartbeat',
        // UI tasks run as isolated turns for consistent behavior and delivery.
        sessionTarget: 'isolated',
        agentId,
        ...((deliveryRoute?.sessionKey || fallbackDelivery?.sessionKey)
          ? { sessionKey: deliveryRoute?.sessionKey ?? fallbackDelivery?.sessionKey }
          : {}),
        delivery: targetChannelType
          ? (deliveryRoute?.delivery ?? fallbackDelivery?.delivery ?? {
            mode: 'announce',
            channel: toOpenClawChannelType(targetChannelType),
            ...(targetAccountId ? { accountId: targetAccountId } : {}),
            ...(targetRecipientId ? { to: targetRecipientId } : {}),
            bestEffort: true,
          })
          : { mode: 'none' },
      });
      sendJson(res, 200, result && typeof result === 'object' ? transformCronJob(result as GatewayCronJob) : result);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/cron/jobs/') && req.method === 'PUT') {
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/cron/jobs/'.length));
      const input = await parseJsonBody<Record<string, unknown>>(req);
      const patch = { ...input };
      if (typeof patch.schedule === 'string') {
        patch.schedule = { kind: 'cron', expr: patch.schedule };
      }
      const patchMessage = typeof patch.message === 'string' ? patch.message : '';
      const hasPatchedAgentId = Object.prototype.hasOwnProperty.call(patch, 'agentId');
      const patchAgentId = typeof patch.agentId === 'string' && patch.agentId.trim()
        ? patch.agentId.trim()
        : 'main';
      const hasPatchedTargetChannelType = Object.prototype.hasOwnProperty.call(patch, 'targetChannelType');
      const hasPatchedTargetAccountId = Object.prototype.hasOwnProperty.call(patch, 'targetAccountId');
      const hasPatchedTargetRecipientId = Object.prototype.hasOwnProperty.call(patch, 'targetRecipientId');
      const targetChannelType = hasPatchedTargetChannelType
        ? (typeof patch.targetChannelType === 'string' && patch.targetChannelType.trim()
          ? patch.targetChannelType.trim()
          : '')
        : '';
      const targetAccountId = hasPatchedTargetAccountId
        ? (typeof patch.targetAccountId === 'string' && patch.targetAccountId.trim()
          ? patch.targetAccountId.trim()
          : '')
        : '';
      const targetRecipientId = hasPatchedTargetRecipientId
        ? (typeof patch.targetRecipientId === 'string' && patch.targetRecipientId.trim()
          ? patch.targetRecipientId.trim()
          : '')
        : '';
      // Resolve final execution mode from existing job + patch so message-only updates
      // keep the correct payload kind.
      let previousJob: GatewayCronJob | undefined;
      try {
        previousJob = await findCronJobById(ctx, id);
      } catch {
        previousJob = undefined;
      }
      const effectiveAgentId = hasPatchedAgentId
        ? patchAgentId
        : getGatewayCronJobAgentId(previousJob);
      if (typeof patch.message === 'string') {
        patch.payload = buildIsolatedCronPayload(patchMessage);
        delete patch.message;
      } else if ((hasPatchedAgentId || hasPatchedTargetChannelType) && previousJob?.payload) {
        const fallbackMessage = previousJob.payload.message || previousJob.payload.text || '';
        patch.payload = buildIsolatedCronPayload(fallbackMessage);
      }
      if (hasPatchedAgentId) {
        patch.agentId = patchAgentId;
        patch.sessionTarget = 'isolated';
      }
      if (
        hasPatchedAgentId
        && !hasPatchedTargetChannelType
        && previousJob?.delivery?.mode === 'announce'
        && typeof previousJob.delivery.channel === 'string'
      ) {
        const existingChannelType = toUiChannelType(previousJob.delivery.channel);
        const bestEffort = typeof previousJob.delivery.bestEffort === 'boolean'
          ? previousJob.delivery.bestEffort
          : true;
        const resolvedRoute = await resolveCronDeliveryRoute({
          agentId: patchAgentId,
          channelType: existingChannelType,
          previousSessionKey: previousJob?.sessionKey,
          bestEffort,
        });
        if (resolvedRoute) {
          patch.sessionKey = resolvedRoute.sessionKey;
          patch.delivery = resolvedRoute.delivery;
        } else {
          patch.sessionKey = null;
          patch.delivery = {
            mode: 'announce',
            channel: previousJob.delivery.channel,
            bestEffort,
          };
        }
      }
      const shouldRebuildDeliveryRoute =
        hasPatchedTargetChannelType || hasPatchedTargetAccountId || hasPatchedTargetRecipientId;
      if (shouldRebuildDeliveryRoute) {
        const effectiveTargetChannelType = hasPatchedTargetChannelType
          ? targetChannelType
          : (previousJob?.delivery?.channel ? toUiChannelType(previousJob.delivery.channel) : '');
        const effectiveTargetAccountId = hasPatchedTargetAccountId
          ? targetAccountId
          : (typeof previousJob?.delivery?.accountId === 'string' ? previousJob.delivery.accountId : '');
        const effectiveTargetRecipientId = hasPatchedTargetRecipientId
          ? targetRecipientId
          : '';
        if (effectiveTargetChannelType) {
          const bestEffort = typeof previousJob?.delivery?.bestEffort === 'boolean'
            ? previousJob.delivery.bestEffort
            : true;
          const resolvedRoute = await resolveCronDeliveryRoute({
            agentId: effectiveAgentId,
            channelType: effectiveTargetChannelType,
            previousSessionKey: previousJob?.sessionKey,
            bestEffort,
            preferredAccountId: effectiveTargetAccountId || undefined,
            preferredRecipientId: effectiveTargetRecipientId || undefined,
          });
          const fallbackState = buildFallbackChannelDeliveryStateForUpdate({
            targetChannelType: effectiveTargetChannelType,
            previousJob,
            bestEffort,
            preferredAccountId: effectiveTargetAccountId || undefined,
            preferredRecipientId: effectiveTargetRecipientId || undefined,
          });
          patch.delivery = resolvedRoute?.delivery ?? fallbackState.delivery;
          patch.sessionKey = resolvedRoute?.sessionKey ?? fallbackState.sessionKey;
        } else {
          patch.delivery = { mode: 'none' };
          patch.sessionKey = null;
        }
        patch.sessionTarget = 'isolated';
      }
      delete patch.targetChannelType;
      delete patch.targetAccountId;
      delete patch.targetRecipientId;
      const updated = await ctx.gatewayManager.rpc('cron.update', { id, patch });
      sendJson(
        res,
        200,
        updated && typeof updated === 'object'
          ? transformCronJob(updated as GatewayCronJob)
          : updated,
      );
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/cron/jobs/') && req.method === 'DELETE') {
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/cron/jobs/'.length));
      sendJson(res, 200, await ctx.gatewayManager.rpc('cron.remove', { id }));
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/cron/toggle' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ id: string; enabled: boolean }>(req);
      sendJson(res, 200, await ctx.gatewayManager.rpc('cron.update', { id: body.id, patch: { enabled: body.enabled } }));
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/cron/trigger' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ id: string }>(req);
      sendJson(res, 200, await ctx.gatewayManager.rpc('cron.run', { id: body.id, mode: 'force' }));
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
