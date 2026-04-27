/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BrainCircuit,
  ListTodo,
  Loader2,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ChatToolbar } from './ChatToolbar';
import { extractImages, extractText, extractThinking, extractToolUse } from './message-utils';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useStickToBottomInstant } from '@/hooks/use-stick-to-bottom-instant';
import { useMinLoading } from '@/hooks/use-min-loading';
import { useNavigate } from 'react-router-dom';
import { hostApiFetch } from '@/lib/host-api';
import { toast } from 'sonner';

function normalizeComparableText(value: string | null | undefined): string {
  return (value || '').trim().replace(/\s+/g, ' ');
}

function buildRenderableAssistantSignature(
  message: RawMessage,
  showThinking: boolean
): string | null {
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : 'assistant';
  if (role !== 'assistant') return null;

  const text = normalizeComparableText(extractText(message));
  const thinking = showThinking ? normalizeComparableText(extractThinking(message) || '') : '';
  const tools = JSON.stringify(
    extractToolUse(message).map((tool) => ({
      id: tool.id || '',
      name: tool.name || '',
      input: tool.input ?? null,
    }))
  );
  const images = extractImages(message)
    .map((img) => `${img.mimeType}:${img.data.length}`)
    .join('|');

  return JSON.stringify({ text, thinking, tools, images });
}

export function Chat() {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const gatewayStatus = useGatewayStore((s) => s.status);
  const startGateway = useGatewayStore((s) => s.start);
  const restartGateway = useGatewayStore((s) => s.restart);
  const setGatewayStatus = useGatewayStore((s) => s.setStatus);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const [startingSince, setStartingSince] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [gatewayAction, setGatewayAction] = useState<null | 'start' | 'restart' | 'refresh'>(null);

  const messages = useChatStore((s) => s.messages);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const loading = useChatStore((s) => s.loading);
  const sending = useChatStore((s) => s.sending);
  const error = useChatStore((s) => s.error);
  const showThinking = useChatStore((s) => s.showThinking);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const streamingTools = useChatStore((s) => s.streamingTools);
  const pendingFinal = useChatStore((s) => s.pendingFinal);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abortRun = useChatStore((s) => s.abortRun);
  const clearError = useChatStore((s) => s.clearError);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const cleanupEmptySession = useChatStore((s) => s.cleanupEmptySession);

  const [streamingTimestamp, setStreamingTimestamp] = useState<number>(0);
  const minLoading = useMinLoading(loading && messages.length > 0);
  const { contentRef, scrollRef } = useStickToBottomInstant(currentSessionKey);

  // Load data when gateway is running.
  // When the store already holds messages for this session (i.e. the user
  // is navigating *back* to Chat), use quiet mode so the existing messages
  // stay visible while fresh data loads in the background.  This avoids
  // an unnecessary messages → spinner → messages flicker.
  useEffect(() => {
    return () => {
      // If the user navigates away without sending any messages, remove the
      // empty session so it doesn't linger as a ghost entry in the sidebar.
      cleanupEmptySession();
    };
  }, [cleanupEmptySession]);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    if (gatewayStatus.state === 'starting' || gatewayStatus.state === 'reconnecting') {
      setStartingSince((prev) => prev ?? Date.now());
      return;
    }
    setStartingSince(null);
  }, [gatewayStatus.state]);

  useEffect(() => {
    if (startingSince == null) return;
    const timer = window.setInterval(() => {
      setClockTick((v) => v + 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [startingSince]);

  // Update timestamp when sending starts
  useEffect(() => {
    if (sending && streamingTimestamp === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStreamingTimestamp(Date.now() / 1000);
    } else if (!sending && streamingTimestamp !== 0) {
      setStreamingTimestamp(0);
    }
  }, [sending, streamingTimestamp]);

  // Gateway not running block has been completely removed so the UI always renders.

  const streamMsg =
    streamingMessage && typeof streamingMessage === 'object'
      ? (streamingMessage as unknown as { role?: string; content?: unknown; timestamp?: number })
      : null;
  const streamText = streamMsg
    ? extractText(streamMsg)
    : typeof streamingMessage === 'string'
      ? streamingMessage
      : '';
  const hasStreamText = streamText.trim().length > 0;
  const streamThinking = streamMsg ? extractThinking(streamMsg) : null;
  const hasStreamThinking = showThinking && !!streamThinking && streamThinking.trim().length > 0;
  const streamTools = streamMsg ? extractToolUse(streamMsg) : [];
  const hasStreamTools = streamTools.length > 0;
  const streamImages = streamMsg ? extractImages(streamMsg) : [];
  const hasStreamImages = streamImages.length > 0;
  const hasStreamToolStatus = streamingTools.length > 0;
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((msg) => (typeof msg.role === 'string' ? msg.role.toLowerCase() : '') === 'assistant');
  const persistedAssistantSignature = lastAssistantMessage
    ? buildRenderableAssistantSignature(lastAssistantMessage, showThinking)
    : null;
  const streamingAssistantSignature = streamMsg
    ? buildRenderableAssistantSignature(
        {
          ...(streamMsg as Record<string, unknown>),
          role: (typeof streamMsg.role === 'string'
            ? streamMsg.role
            : 'assistant') as RawMessage['role'],
          content: streamMsg.content ?? streamText,
          timestamp: streamMsg.timestamp ?? streamingTimestamp,
        } as RawMessage,
        showThinking
      )
    : streamText.trim().length > 0
      ? buildRenderableAssistantSignature(
          {
            role: 'assistant',
            content: streamText,
            timestamp: streamingTimestamp,
          } as RawMessage,
          showThinking
        )
      : null;
  const isDuplicateOfPersistedAssistant =
    !!persistedAssistantSignature &&
    !!streamingAssistantSignature &&
    persistedAssistantSignature === streamingAssistantSignature;
  const shouldRenderStreaming =
    sending &&
    !isDuplicateOfPersistedAssistant &&
    (hasStreamText ||
      hasStreamThinking ||
      hasStreamTools ||
      hasStreamImages ||
      hasStreamToolStatus);
  const hasAnyStreamContent =
    hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus;

  void clockTick;
  const startingTooLong = startingSince != null && Date.now() - startingSince > 20_000;

  const refreshGatewayStatus = async () => {
    try {
      setGatewayAction('refresh');
      const status = await hostApiFetch<{
        state: 'stopped' | 'starting' | 'running' | 'error' | 'reconnecting';
        port: number;
        pid?: number;
        uptime?: number;
        error?: string;
        connectedAt?: number;
        version?: string;
        reconnectAttempts?: number;
      }>('/api/gateway/status');
      setGatewayStatus(status);
      toast.success(
        status.state === 'running' ? `网关运行中，端口 ${status.port}` : `网关状态：${status.state}`
      );
    } catch {
      toast.error('刷新网关状态失败');
    } finally {
      setGatewayAction(null);
    }
  };

  const handleStartGateway = async () => {
    setGatewayAction('start');
    toast.info('正在启动网关...');
    try {
      await startGateway();
      toast.success('已发送启动请求');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setGatewayAction(null);
    }
  };

  const handleRestartGateway = async () => {
    setGatewayAction('restart');
    toast.info('正在重启网关...');
    try {
      await restartGateway();
      toast.success('已发送重启请求');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setGatewayAction(null);
    }
  };

  const isEmpty = messages.length === 0 && !sending;

  return (
    <div
      className={cn(
        'relative flex flex-col -m-6 transition-colors duration-500 dark:bg-background'
      )}
      style={{ height: '100vh' }}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-end px-4 py-2">
        <ChatToolbar />
      </div>

      {!isGatewayRunning && (
        <div className="shrink-0 px-4 pb-2">
          <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-amber-700 dark:text-amber-300">
                {t('gatewayNotRunning')}
              </div>
              <div className="truncate text-[11px] text-amber-700/80 dark:text-amber-200/80">
                {gatewayStatus.state === 'error' && gatewayStatus.error
                  ? gatewayStatus.error
                  : t('gatewayRequired')}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => navigate('/settings')}
              >
                去设置
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 text-[11px]"
                disabled={
                  gatewayStatus.state === 'starting' ||
                  gatewayStatus.state === 'reconnecting' ||
                  gatewayAction !== null
                }
                onClick={() => void handleStartGateway()}
              >
                {gatewayAction === 'start' ||
                gatewayStatus.state === 'starting' ||
                gatewayStatus.state === 'reconnecting'
                  ? '启动中...'
                  : '立即启动'}
              </Button>
              {startingTooLong && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  disabled={gatewayAction !== null}
                  onClick={() => void handleRestartGateway()}
                >
                  {gatewayAction === 'restart' ? '重试中...' : '重试启动'}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-[11px]"
                disabled={gatewayAction !== null}
                onClick={() => void refreshGatewayStatus()}
              >
                {gatewayAction === 'refresh' ? '刷新中...' : '刷新状态'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div ref={contentRef} className="max-w-4xl mx-auto space-y-4">
          {isEmpty ? (
            <WelcomeScreen onQuickStart={sendMessage} />
          ) : (
            <>
              {messages.map((msg, idx) => (
                <ChatMessage
                  key={msg.id || `msg-${idx}`}
                  message={msg}
                  showThinking={showThinking}
                />
              ))}

              {/* Streaming message */}
              {shouldRenderStreaming && (
                <ChatMessage
                  message={
                    (streamMsg
                      ? {
                          ...(streamMsg as Record<string, unknown>),
                          role: (typeof streamMsg.role === 'string'
                            ? streamMsg.role
                            : 'assistant') as RawMessage['role'],
                          content: streamMsg.content ?? streamText,
                          timestamp: streamMsg.timestamp ?? streamingTimestamp,
                        }
                      : {
                          role: 'assistant',
                          content: streamText,
                          timestamp: streamingTimestamp,
                        }) as RawMessage
                  }
                  showThinking={showThinking}
                  isStreaming
                  streamingTools={streamingTools}
                />
              )}

              {/* Activity indicator: waiting for next AI turn after tool execution */}
              {sending && pendingFinal && !shouldRenderStreaming && (
                <ActivityIndicator phase="tool_processing" />
              )}

              {/* Typing indicator when sending but no stream content yet */}
              {sending && !pendingFinal && !hasAnyStreamContent && <TypingIndicator />}
            </>
          )}
        </div>
      </div>

      {/* Error bar */}
      {error && (
        <div className="px-4 py-2 bg-destructive/10 border-t border-destructive/20">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <p className="text-sm text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {error}
            </p>
            <button
              onClick={clearError}
              className="text-xs text-destructive/60 hover:text-destructive underline"
            >
              {t('common:actions.dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* Input Area */}
      <ChatInput
        onSend={sendMessage}
        onStop={abortRun}
        disabled={!isGatewayRunning}
        sending={sending}
      />

      {/* Transparent loading overlay */}
      {minLoading && !sending && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/20 backdrop-blur-[1px] rounded-xl pointer-events-auto">
          <div className="bg-background shadow-lg rounded-full p-2.5 border border-border">
            <LoadingSpinner size="md" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Welcome Screen ──────────────────────────────────────────────

function WelcomeScreen({ onQuickStart }: { onQuickStart: (text: string) => Promise<void> }) {
  const { t } = useTranslation('chat');
  const quickActions = [
    {
      key: 'askQuestions',
      icon: ListTodo,
      label: t('welcome.askQuestions'),
      description: t('welcome.askQuestionsDesc'),
      prompt: t('welcome.askQuestionsPrompt'),
    },
    {
      key: 'creativeTasks',
      icon: Workflow,
      label: t('welcome.creativeTasks'),
      description: t('welcome.creativeTasksDesc'),
      prompt: t('welcome.creativeTasksPrompt'),
    },
    {
      key: 'brainstorming',
      icon: BrainCircuit,
      label: t('welcome.brainstorming'),
      description: t('welcome.brainstormingDesc'),
      prompt: t('welcome.brainstormingPrompt'),
    },
    {
      key: 'quickFix',
      icon: Sparkles,
      label: t('welcome.quickFix'),
      description: t('welcome.quickFixDesc'),
      prompt: t('welcome.quickFixPrompt'),
    },
  ];

  return (
    <div className="flex min-h-[54vh] items-center justify-center py-4">
      <div className="w-full max-w-4xl px-4">
        <div className="space-y-5">
          <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
            <h1 className="max-w-2xl whitespace-nowrap text-2xl font-semibold tracking-[-0.03em] text-[#134e4a] dark:text-white sm:text-[34px]">
              {t('welcome.subtitle')}
            </h1>
            <p className="mt-2 max-w-lg text-[13px] leading-6 text-[#47645f] dark:text-white/68">
              {t('welcome.description')}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            {quickActions.map(({ key, icon: Icon, label, description, prompt }) => (
              <button
                key={key}
                type="button"
                onClick={() => void onQuickStart(prompt)}
                className="group cursor-pointer rounded-[18px] border border-black/8 bg-white p-3 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-[#14b8a6]/30 hover:shadow-[0_16px_32px_-24px_rgba(20,184,166,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14b8a6]/45 dark:border-white/10 dark:bg-white/8 dark:hover:border-[#5eead4]/35 dark:hover:bg-white/[0.11]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#0f766e]/8 text-[#0f766e] transition-colors group-hover:bg-[#0f766e] group-hover:text-white dark:bg-white/10 dark:text-[#5eead4] dark:group-hover:bg-[#14b8a6] dark:group-hover:text-slate-950">
                    <Icon className="h-4.5 w-4.5" />
                  </div>
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#0f766e]/45 transition-all group-hover:translate-x-0.5 group-hover:text-[#0f766e] dark:text-white/35 dark:group-hover:text-[#5eead4]" />
                </div>
                <div className="mt-2.5 space-y-1">
                  <div className="text-[14px] font-semibold text-slate-900 dark:text-white">
                    {label}
                  </div>
                  <p className="text-[12px] leading-5 text-slate-600 dark:text-white/65">
                    {description}
                  </p>
                </div>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-1.5 text-[11px] text-[#47645f] dark:text-white/52">
            <span className="rounded-full border border-black/8 bg-white/70 px-2.5 py-0.5 dark:border-white/10 dark:bg-white/6">
              {t('welcome.tipModel')}
            </span>
            <span className="rounded-full border border-black/8 bg-white/70 px-2.5 py-0.5 dark:border-white/10 dark:bg-white/6">
              {t('welcome.tipSkill')}
            </span>
            <span className="rounded-full border border-black/8 bg-white/70 px-2.5 py-0.5 dark:border-white/10 dark:bg-white/6">
              {t('welcome.tipAgent')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Typing Indicator ────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3">
        <div className="flex gap-1">
          <span
            className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce"
            style={{ animationDelay: '0ms' }}
          />
          <span
            className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce"
            style={{ animationDelay: '150ms' }}
          />
          <span
            className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce"
            style={{ animationDelay: '300ms' }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Activity Indicator (shown between tool cycles) ─────────────

function ActivityIndicator({ phase }: { phase: 'tool_processing' }) {
  void phase;
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>Processing tool results…</span>
        </div>
      </div>
    </div>
  );
}

export default Chat;
