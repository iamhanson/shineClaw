import { invokeIpc } from '@/lib/api-client';
import { useAgentsStore } from '@/stores/agents';
import { toast } from 'sonner';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  getLastChatEventAt,
  setHistoryPollTimer,
  setLastChatEventAt,
  upsertImageCacheEntry,
} from './helpers';
import type { ChatSession, RawMessage } from './types';
import type { ChatGet, ChatSet, RuntimeActions } from './store-api';

function normalizeAgentId(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase() || 'main';
}

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

function getCanonicalPrefixFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

function buildFallbackMainSessionKey(agentId: string): string {
  return `agent:${normalizeAgentId(agentId)}:main`;
}

function buildFreshSessionKey(baseSessionKey: string): string {
  const prefix = getCanonicalPrefixFromSessionKey(baseSessionKey) ?? 'agent:main';
  return `${prefix}:session-${Date.now()}`;
}

function resolveMainSessionKeyForAgent(agentId: string | undefined | null): string | null {
  if (!agentId) return null;
  const normalizedAgentId = normalizeAgentId(agentId);
  const summary = useAgentsStore.getState().agents.find((agent) => agent.id === normalizedAgentId);
  return summary?.mainSessionKey || buildFallbackMainSessionKey(normalizedAgentId);
}

function ensureSessionEntry(sessions: ChatSession[], sessionKey: string): ChatSession[] {
  if (sessions.some((session) => session.key === sessionKey)) {
    return sessions;
  }
  return [...sessions, { key: sessionKey, displayName: sessionKey }];
}

function isContextOverflowError(error: unknown): boolean {
  const message = String(error ?? '').toLowerCase();
  return (
    message.includes('context overflow') ||
    message.includes('prompt too large for the model') ||
    message.includes('maximum context length') ||
    message.includes('context length exceeded') ||
    message.includes('too many tokens') ||
    message.includes('prompt is too long')
  );
}

export function createRuntimeSendActions(set: ChatSet, get: ChatGet): Pick<RuntimeActions, 'sendMessage' | 'abortRun'> {
  return {
    sendMessage: async (
      text: string,
      attachments?: Array<{ fileName: string; mimeType: string; fileSize: number; stagedPath: string; preview: string | null }>,
      targetAgentId?: string | null,
    ) => {
      const trimmed = text.trim();
      if (!trimmed && (!attachments || attachments.length === 0)) return;

      const sendWithRecovery = async (
        sessionKeyOverride?: string,
        allowOverflowRecovery = true,
      ): Promise<void> => {
        const targetSessionKey = sessionKeyOverride
          ?? resolveMainSessionKeyForAgent(targetAgentId)
          ?? get().currentSessionKey;
        if (targetSessionKey !== get().currentSessionKey) {
          const current = get();
          const leavingEmpty = !current.currentSessionKey.endsWith(':main') && current.messages.length === 0;
          set((s) => ({
            currentSessionKey: targetSessionKey,
            currentAgentId: getAgentIdFromSessionKey(targetSessionKey),
            sessions: ensureSessionEntry(
              leavingEmpty ? s.sessions.filter((session) => session.key !== current.currentSessionKey) : s.sessions,
              targetSessionKey,
            ),
            sessionLabels: leavingEmpty
              ? Object.fromEntries(Object.entries(s.sessionLabels).filter(([key]) => key !== current.currentSessionKey))
              : s.sessionLabels,
            sessionLastActivity: leavingEmpty
              ? Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([key]) => key !== current.currentSessionKey))
              : s.sessionLastActivity,
            messages: [],
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            activeRunId: null,
            error: null,
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
          }));
          await get().loadHistory(true);
        }

        const currentSessionKey = targetSessionKey;
        const stateBeforeSend = get();
        const sessionHadHistoryBeforeSend =
          stateBeforeSend.messages.length > 0 ||
          !!stateBeforeSend.sessionLastActivity[currentSessionKey] ||
          !!stateBeforeSend.sessionLabels[currentSessionKey];

        const nowMs = Date.now();
        const userMsg: RawMessage = {
          role: 'user',
          content: trimmed || (attachments?.length ? '(file attached)' : ''),
          timestamp: nowMs / 1000,
          id: crypto.randomUUID(),
          _attachedFiles: attachments?.map(a => ({
            fileName: a.fileName,
            mimeType: a.mimeType,
            fileSize: a.fileSize,
            preview: a.preview,
            filePath: a.stagedPath,
          })),
        };
        set((s) => ({
          messages: [...s.messages, userMsg],
          sending: true,
          error: null,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: nowMs,
        }));

        const { sessionLabels, messages } = get();
        const isFirstMessage = !messages.slice(0, -1).some((m) => m.role === 'user');
        if (!currentSessionKey.endsWith(':main') && isFirstMessage && !sessionLabels[currentSessionKey] && trimmed) {
          const truncated = trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed;
          set((s) => ({ sessionLabels: { ...s.sessionLabels, [currentSessionKey]: truncated } }));
        }

        set((s) => ({ sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: nowMs } }));

        setLastChatEventAt(Date.now());
        clearHistoryPoll();
        clearErrorRecoveryTimer();

        const POLL_START_DELAY = 3_000;
        const POLL_INTERVAL = 4_000;
        const pollHistory = () => {
          const state = get();
          if (!state.sending) { clearHistoryPoll(); return; }
          if (state.streamingMessage) {
            setHistoryPollTimer(setTimeout(pollHistory, POLL_INTERVAL));
            return;
          }
          state.loadHistory(true);
          setHistoryPollTimer(setTimeout(pollHistory, POLL_INTERVAL));
        };
        setHistoryPollTimer(setTimeout(pollHistory, POLL_START_DELAY));

        const SAFETY_TIMEOUT_MS = 90_000;
        const checkStuck = () => {
          const state = get();
          if (!state.sending) return;
          if (state.streamingMessage || state.streamingText) return;
          if (state.pendingFinal) {
            setTimeout(checkStuck, 10_000);
            return;
          }
          if (Date.now() - getLastChatEventAt() < SAFETY_TIMEOUT_MS) {
            setTimeout(checkStuck, 10_000);
            return;
          }
          clearHistoryPoll();
          set({
            error: 'No response received from the model. The provider may be unavailable or the API key may have insufficient quota. Please check your provider settings.',
            sending: false,
            activeRunId: null,
            lastUserMessageAt: null,
          });
        };
        setTimeout(checkStuck, 30_000);

        try {
          const idempotencyKey = crypto.randomUUID();
          const hasMedia = attachments && attachments.length > 0;
          if (hasMedia) {
            console.log('[sendMessage] Media paths:', attachments!.map(a => a.stagedPath));
          }

          if (hasMedia && attachments) {
            for (const a of attachments) {
              upsertImageCacheEntry(a.stagedPath, {
                fileName: a.fileName,
                mimeType: a.mimeType,
                fileSize: a.fileSize,
                preview: a.preview,
              });
            }
          }

          let result: { success: boolean; result?: { runId?: string }; error?: string };
          const CHAT_SEND_TIMEOUT_MS = 120_000;

          if (hasMedia) {
            result = await invokeIpc(
              'chat:sendWithMedia',
              {
                sessionKey: currentSessionKey,
                message: trimmed || 'Process the attached file(s).',
                deliver: false,
                idempotencyKey,
                media: attachments.map((a) => ({
                  filePath: a.stagedPath,
                  mimeType: a.mimeType,
                  fileName: a.fileName,
                })),
              },
            ) as { success: boolean; result?: { runId?: string }; error?: string };
          } else {
            result = await invokeIpc(
              'gateway:rpc',
              'chat.send',
              {
                sessionKey: currentSessionKey,
                message: trimmed,
                deliver: false,
                idempotencyKey,
              },
              CHAT_SEND_TIMEOUT_MS,
            ) as { success: boolean; result?: { runId?: string }; error?: string };
          }

          console.log(`[sendMessage] RPC result: success=${result.success}, runId=${result.result?.runId || 'none'}`);

          if (!result.success) {
            const errorMessage = result.error || 'Failed to send message';
            if (allowOverflowRecovery && isContextOverflowError(errorMessage)) {
              clearHistoryPoll();
              const freshSessionKey = buildFreshSessionKey(currentSessionKey);
              set((s) => ({
                currentSessionKey: freshSessionKey,
                currentAgentId: getAgentIdFromSessionKey(freshSessionKey),
                sessions: ensureSessionEntry(
                  !sessionHadHistoryBeforeSend && !currentSessionKey.endsWith(':main')
                    ? s.sessions.filter((session) => session.key !== currentSessionKey)
                    : s.sessions,
                  freshSessionKey,
                ),
                sessionLabels:
                  !sessionHadHistoryBeforeSend && !currentSessionKey.endsWith(':main')
                    ? Object.fromEntries(
                        Object.entries(s.sessionLabels).filter(([key]) => key !== currentSessionKey)
                      )
                    : s.sessionLabels,
                sessionLastActivity:
                  !sessionHadHistoryBeforeSend && !currentSessionKey.endsWith(':main')
                    ? Object.fromEntries(
                        Object.entries(s.sessionLastActivity).filter(([key]) => key !== currentSessionKey)
                      )
                    : s.sessionLastActivity,
                messages: [],
                sending: false,
                error: null,
                streamingText: '',
                streamingMessage: null,
                streamingTools: [],
                activeRunId: null,
                pendingFinal: false,
                lastUserMessageAt: null,
                pendingToolImages: [],
              }));
              toast.info('当前会话上下文过长，已自动切换到新对话后重试。');
              await sendWithRecovery(freshSessionKey, false);
              return;
            }

            clearHistoryPoll();
            set({ error: errorMessage, sending: false });
          } else if (result.result?.runId) {
            set({ activeRunId: result.result.runId });
          }
        } catch (err) {
          const errorMessage = String(err);
          if (allowOverflowRecovery && isContextOverflowError(errorMessage)) {
            clearHistoryPoll();
            const freshSessionKey = buildFreshSessionKey(currentSessionKey);
            set((s) => ({
              currentSessionKey: freshSessionKey,
              currentAgentId: getAgentIdFromSessionKey(freshSessionKey),
              sessions: ensureSessionEntry(
                !sessionHadHistoryBeforeSend && !currentSessionKey.endsWith(':main')
                  ? s.sessions.filter((session) => session.key !== currentSessionKey)
                  : s.sessions,
                freshSessionKey,
              ),
              sessionLabels:
                !sessionHadHistoryBeforeSend && !currentSessionKey.endsWith(':main')
                  ? Object.fromEntries(
                      Object.entries(s.sessionLabels).filter(([key]) => key !== currentSessionKey)
                    )
                  : s.sessionLabels,
              sessionLastActivity:
                !sessionHadHistoryBeforeSend && !currentSessionKey.endsWith(':main')
                  ? Object.fromEntries(
                      Object.entries(s.sessionLastActivity).filter(([key]) => key !== currentSessionKey)
                    )
                  : s.sessionLastActivity,
              messages: [],
              sending: false,
              error: null,
              streamingText: '',
              streamingMessage: null,
              streamingTools: [],
              activeRunId: null,
              pendingFinal: false,
              lastUserMessageAt: null,
              pendingToolImages: [],
            }));
            toast.info('当前会话上下文过长，已自动切换到新对话后重试。');
            await sendWithRecovery(freshSessionKey, false);
            return;
          }

          clearHistoryPoll();
          set({ error: errorMessage, sending: false });
        }
      };

      await sendWithRecovery();
    },

    // ── Abort active run ──

    abortRun: async () => {
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      const { currentSessionKey } = get();
      set({ sending: false, streamingText: '', streamingMessage: null, pendingFinal: false, lastUserMessageAt: null, pendingToolImages: [] });
      set({ streamingTools: [] });

      try {
        await invokeIpc(
          'gateway:rpc',
          'chat.abort',
          { sessionKey: currentSessionKey },
        );
      } catch (err) {
        set({ error: String(err) });
      }
    },

    // ── Handle incoming chat events from Gateway ──

  };
}
