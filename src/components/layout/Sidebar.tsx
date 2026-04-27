/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 * Full-height sidebar with platform-specific drag region at top.
 * macOS: drag region for native traffic lights (hiddenInset).
 * Windows: drag region with custom minimize/maximize/close controls.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeft,
  Plus,
  MessageSquarePlus,
  ExternalLink,
  Trash2,
  ChevronRight,
  ChevronDown,
  Search,
  X,
  Pencil,
  Cpu,
  Bot,
  Network,
  Puzzle,
  MonitorCog,
  Mail,
  PlusCircle,
  CalendarDays,
  Minus,
  Square,
  Copy,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import type { QuickAccessRoute } from '@/stores/settings';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { useTranslation } from 'react-i18next';
import logoSvg from '@/assets/logo-default.png';
import alarmIcon from '@/assets/alarm.svg';
import groupIcon from '@/assets/group.svg';

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

export function Sidebar() {
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);
  const sidebarWidth = useSettingsStore((state) => state.sidebarWidth);
  const setSidebarWidth = useSettingsStore((state) => state.setSidebarWidth);
  const quickAccessRoutes = useSettingsStore((state) => state.quickAccessRoutes);
  const setQuickAccessRoutes = useSettingsStore((state) => state.setQuickAccessRoutes);

  // Drag-to-resize
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = sidebarWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        const newWidth = startWidth.current + (ev.clientX - startX.current);
        setSidebarWidth(newWidth);
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [sidebarWidth, setSidebarWidth]
  );

  const sessions = useChatStore((s) => s.sessions);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const sessionCustomLabels = useChatStore((s) => s.sessionCustomLabels);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const switchSession = useChatStore((s) => s.switchSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const newSession = useChatStore((s) => s.newSession);
  const newSessionForAgent = useChatStore((s) => s.newSessionForAgent);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadHistory = useChatStore((s) => s.loadHistory);

  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';

  useEffect(() => {
    if (!isGatewayRunning) return;
    let cancelled = false;
    const hasExistingMessages = useChatStore.getState().messages.length > 0;
    (async () => {
      await loadSessions();
      if (cancelled) return;
      await loadHistory(hasExistingMessages);
    })();
    return () => {
      cancelled = true;
    };
  }, [isGatewayRunning, loadHistory, loadSessions]);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const navigate = useNavigate();
  const location = useLocation();
  const isOnChat = location.pathname === '/';
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [groupByAgent, setGroupByAgent] = useState(true);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const sessionSearchRef = useRef<HTMLDivElement | null>(null);
  const quickMenuRef = useRef<HTMLDivElement | null>(null);

  const getSessionLabel = useCallback(
    (key: string, displayName?: string, label?: string) =>
      sessionCustomLabels[key] ?? sessionLabels[key] ?? label ?? displayName ?? key,
    [sessionCustomLabels, sessionLabels]
  );

  const openDevConsole = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        error?: string;
      }>('/api/gateway/control-ui');
      if (result.success && result.url) {
        window.electron.openExternal(result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (err) {
      console.error('Error opening Dev Console:', err);
    }
  };

  const { t } = useTranslation(['common', 'chat', 'settings', 'agents']);
  const [sessionToDelete, setSessionToDelete] = useState<{ key: string; label: string } | null>(
    null
  );
  const [sessionToRename, setSessionToRename] = useState<{ key: string; label: string } | null>(
    null
  );
  const [renameDraft, setRenameDraft] = useState('');
  useEffect(() => {
    if (!settingsMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!settingsMenuRef.current?.contains(event.target as Node)) {
        setSettingsMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [settingsMenuOpen]);

  useEffect(() => {
    if (!agentMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!agentMenuRef.current?.contains(event.target as Node)) {
        setAgentMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAgentMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [agentMenuOpen]);

  useEffect(() => {
    if (!sessionSearchOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!sessionSearchRef.current?.contains(event.target as Node) && !sessionSearchQuery.trim()) {
        setSessionSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [sessionSearchOpen, sessionSearchQuery]);

  useEffect(() => {
    if (!quickMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!quickMenuRef.current?.contains(event.target as Node)) {
        setQuickMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setQuickMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [quickMenuOpen]);

  const submitRenameSession = useCallback(() => {
    if (!sessionToRename) return;
    const trimmed = renameDraft.trim();
    if (!trimmed) return;
    renameSession(sessionToRename.key, trimmed);
    setSessionToRename(null);
    setRenameDraft('');
  }, [renameDraft, renameSession, sessionToRename]);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const agentNameById = useMemo(
    () =>
      Object.fromEntries(
        (agents ?? []).map((agent) => [
          agent.id,
          agent.isDefault ? t('agents:defaultAgentName') : agent.name,
        ])
      ),
    [agents, t]
  );
  const sortedSessions = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => (sessionLastActivity[b.key] ?? 0) - (sessionLastActivity[a.key] ?? 0)
      ),
    [sessions, sessionLastActivity]
  );
  const filteredSessions = useMemo(() => {
    const query = sessionSearchQuery.trim().toLowerCase();
    if (!query) return sortedSessions;
    return sortedSessions.filter((s) => {
      const label = getSessionLabel(s.key, s.displayName, s.label).toLowerCase();
      const agentId = getAgentIdFromSessionKey(s.key);
      const agentName = (agentNameById[agentId] || agentId).toLowerCase();
      return label.includes(query) || agentName.includes(query);
    });
  }, [sortedSessions, sessionSearchQuery, agentNameById, getSessionLabel]);
  const groupedSessions = useMemo(() => {
    const groups = new Map<string, typeof filteredSessions>();
    for (const session of filteredSessions) {
      const agentId = getAgentIdFromSessionKey(session.key);
      const existing = groups.get(agentId);
      if (existing) {
        existing.push(session);
      } else {
        groups.set(agentId, [session]);
      }
    }
    return Array.from(groups.entries()).map(([agentId, items]) => ({
      agentId,
      agentName: agentNameById[agentId] || agentId,
      sessions: items,
    }));
  }, [filteredSessions, agentNameById]);

  const renderSessionItem = useCallback(
    (s: (typeof filteredSessions)[number], showAgentBadge = false) => {
      const agentId = getAgentIdFromSessionKey(s.key);
      const agentName = agentNameById[agentId] || agentId;
      const isRenaming = sessionToRename?.key === s.key;

      return (
        <div key={s.key} className="group relative mb-1 flex items-center">
          {isRenaming ? (
            <div className="flex w-full items-center gap-1 rounded-xl bg-black/5 px-2 py-1.5 dark:bg-white/10">
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitRenameSession();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setSessionToRename(null);
                    setRenameDraft('');
                  }
                }}
                className="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/60"
                placeholder={t('common:sidebar.renameSession')}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                onClick={submitRenameSession}
                title={t('common:actions.save')}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                onClick={() => {
                  setSessionToRename(null);
                  setRenameDraft('');
                }}
                title={t('common:actions.cancel')}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <>
              <button
                onClick={() => {
                  switchSession(s.key);
                  navigate('/');
                }}
                className={cn(
                  'w-full rounded-xl px-2.5 py-1.5 pr-12 text-left text-[12.5px] transition-colors',
                  'hover:bg-black/5 dark:hover:bg-white/5',
                  isOnChat && currentSessionKey === s.key
                    ? 'bg-black/5 dark:bg-white/10 text-foreground font-medium'
                    : 'text-foreground/75'
                )}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  {showAgentBadge && agentId !== 'main' && (
                    <span className="shrink-0 rounded-full bg-black/[0.04] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.06em] text-foreground/70 dark:bg-white/[0.08]">
                      {agentName}
                    </span>
                  )}
                  <span className="truncate">{getSessionLabel(s.key, s.displayName, s.label)}</span>
                </div>
              </button>
              <div
                className={cn(
                  'absolute right-1 flex items-center gap-0.5 transition-opacity',
                  'opacity-0 group-hover:opacity-100'
                )}
              >
                <button
                  aria-label={t('common:sidebar.renameSession')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSessionToRename({
                      key: s.key,
                      label: getSessionLabel(s.key, s.displayName, s.label),
                    });
                    setRenameDraft(getSessionLabel(s.key, s.displayName, s.label));
                  }}
                  className="flex items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                  title={t('common:sidebar.renameSession')}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  aria-label={t('common:actions.delete')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSessionToDelete({
                      key: s.key,
                      label: getSessionLabel(s.key, s.displayName, s.label),
                    });
                  }}
                  className="flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
          )}
        </div>
      );
    },
    [
      agentNameById,
      currentSessionKey,
      getSessionLabel,
      isOnChat,
      navigate,
      renameDraft,
      sessionToRename,
      submitRenameSession,
      switchSession,
      t,
    ]
  );

  const settingsItems = [
    {
      to: '/settings',
      icon: <MonitorCog className="h-[18px] w-[18px]" strokeWidth={2} />,
      label: t('settings:nav.systemSettings', 'System Settings'),
    },
    {
      to: '/calendar',
      icon: <CalendarDays className="h-[18px] w-[18px]" strokeWidth={2} />,
      label: t('common:sidebar.calendar', '日程表'),
    },
    {
      to: '/cron',
      icon: <img src={alarmIcon} alt="" className="h-[18px] w-[18px] shrink-0 dark:invert" />,
      label: t('sidebar.cronTasks'),
    },
    {
      to: '/agents',
      icon: <Bot className="h-[18px] w-[18px]" strokeWidth={2} />,
      label: t('settings:nav.agents', 'Agents'),
    },
    {
      to: '/models',
      icon: <Cpu className="h-[18px] w-[18px]" strokeWidth={2} />,
      label: t('settings:nav.models', 'Models'),
    },
    {
      to: '/channels',
      icon: <Network className="h-[18px] w-[18px]" strokeWidth={2} />,
      label: t('settings:nav.channels', 'Channels'),
    },
    {
      to: '/skills',
      icon: <Puzzle className="h-[18px] w-[18px]" strokeWidth={2} />,
      label: t('settings:nav.skills', 'Skills'),
    },
    {
      to: '/mail',
      icon: <Mail className="h-[18px] w-[18px]" strokeWidth={2} />,
      label: t('common:sidebar.mailAssistant', '邮件助手'),
    },
    {
      to: '__openclaw_external__',
      icon: <ExternalLink className="h-[18px] w-[18px]" strokeWidth={2} />,
      label: t('common:sidebar.openClawPage'),
    },
  ];

  const quickActionCatalog: Array<{
    to: QuickAccessRoute;
    label: string;
    icon: ReactNode;
  }> = settingsItems.map((item) => ({
    to: item.to as QuickAccessRoute,
    label: item.label,
    icon:
      item.to === '/cron' ? (
        <img src={alarmIcon} alt="" className="h-[18px] w-[18px] shrink-0 dark:invert" />
      ) : (
        item.icon
      ),
  }));
  const quickActionByRoute = Object.fromEntries(
    quickActionCatalog.map((item) => [item.to, item])
  ) as Record<QuickAccessRoute, (typeof quickActionCatalog)[number]>;
  const effectiveQuickRoutes = (
    quickAccessRoutes?.length ? quickAccessRoutes : ['/cron']
  ) as QuickAccessRoute[];
  const quickActionMenuItems = quickActionCatalog;

  const toggleQuickRoute = (route: QuickAccessRoute) => {
    const current = effectiveQuickRoutes;
    if (current.includes(route)) {
      const next = current.filter((entry) => entry !== route);
      setQuickAccessRoutes(next.length > 0 ? next : ['/cron']);
      return;
    }
    if (current.length >= 4) return;
    setQuickAccessRoutes([...current, route]);
  };

  const selectableAgents = useMemo(
    () =>
      (agents ?? []).map((agent) => ({
        id: agent.id,
        name: agent.isDefault ? t('agents:defaultAgentName') : agent.name,
      })),
    [agents, t]
  );

  const handleNewChat = () => {
    const { messages } = useChatStore.getState();
    if (messages.length > 0) newSession();
    navigate('/');
  };

  const handleNewAgentChat = (agentId: string) => {
    newSessionForAgent(agentId);
    setAgentMenuOpen(false);
    navigate('/');
  };

  const platform = window.electron?.platform;

  // Collapsed state: horizontal top bar (no left sidebar, just a thin toolbar)
  if (sidebarCollapsed) {
    return (
      <div className="drag-region flex h-10 w-full shrink-0 items-center border-b pt-1">
        {/* macOS traffic lights space - wider to avoid overlap */}
        {platform === 'darwin' && <div className="w-[88px] shrink-0" />}

        {/* Expand button */}
        <Button
          variant="ghost"
          size="icon"
          className="no-drag h-7 w-7 shrink-0 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"
          onClick={() => setSidebarCollapsed(false)}
        >
          <PanelLeft className="h-[17px] w-[17px]" />
        </Button>

        {/* New chat button */}
        <Button
          variant="ghost"
          size="icon"
          className="no-drag h-7 w-7 shrink-0 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 ml-1"
          onClick={handleNewChat}
        >
          <MessageSquarePlus className="h-[17px] w-[17px]" />
        </Button>

        {/* App title */}
        <div className="no-drag flex items-center gap-0.5 ml-2 cursor-default">
          <span className="text-[13px] font-semibold text-foreground">阿山</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </div>

        {/* Spacer (draggable) */}
        <div className="flex-1" />

        {/* Windows controls on far right */}
        {platform === 'win32' && <WindowsControlBar />}
      </div>
    );
  }

  // Expanded state: full-height left sidebar
  return (
    <aside
      className="relative flex shrink-0 flex-col border-r bg-muted/60 dark:bg-background transition-[width] duration-200"
      style={{ width: `${sidebarWidth}px` }}
    >
      {/* Platform-specific drag region at top */}
      {platform === 'darwin' && (
        <div className="drag-region h-10 shrink-0 relative flex items-center justify-end gap-1 pr-2">
          {/* Collapse button */}
          <Button
            variant="ghost"
            size="icon"
            className="no-drag h-7 w-7 shrink-0 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => setSidebarCollapsed(true)}
          >
            <PanelLeftClose className="h-[17px] w-[17px]" />
          </Button>

          {/* New chat button */}
          <Button
            variant="ghost"
            size="icon"
            className="no-drag h-7 w-7 shrink-0 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"
            onClick={handleNewChat}
          >
            <MessageSquarePlus className="h-[17px] w-[17px]" />
          </Button>
        </div>
      )}
      {platform === 'win32' && <WindowsControlBar />}

      {/* Drag handle for resizing */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-primary/20 active:bg-primary/30 transition-colors"
        onMouseDown={handleDragStart}
      />
      {/* Top Header */}
      <div className="flex items-center gap-2 p-2 px-4 h-12">
        <img src={logoSvg} alt="阿山" className="h-7 w-auto shrink-0" />
        <span className="truncate text-[14px] font-semibold tracking-[0.01em] text-foreground">
          阿山
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col px-2 gap-0.5">
        <div className="mb-1 flex items-center gap-1">
          <button
            onClick={handleNewChat}
            className={cn(
              'flex items-center gap-2 rounded-xl border border-black/5 px-2.5 py-2 text-[13px] font-medium transition-colors',
              'bg-black/[0.03] text-foreground shadow-none dark:border-white/5 dark:bg-white/[0.04]',
              selectableAgents.length > 1 ? 'flex-1' : 'w-full'
            )}
          >
            <div className="flex shrink-0 items-center justify-center text-foreground/80">
              <Plus className="h-4 w-4" strokeWidth={2} />
            </div>
            <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">
              {t('sidebar.newChat')}
            </span>
          </button>
          {selectableAgents.length > 1 && (
            <div ref={agentMenuRef} className="relative shrink-0">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 rounded-xl border-black/10 bg-black/[0.03] text-muted-foreground hover:bg-black/10 hover:text-foreground dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/10"
                onClick={() => setAgentMenuOpen((open) => !open)}
                title={t('chat:selectTargetAgent', '选择 Agent')}
              >
                <ChevronDown
                  className={cn('h-3.5 w-3.5 transition-transform', agentMenuOpen && 'rotate-180')}
                />
              </Button>
              {agentMenuOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-52 rounded-xl border border-black/10 bg-background p-1.5 shadow-lg dark:border-white/10">
                  {selectableAgents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => handleNewAgentChat(agent.id)}
                      className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <span className="truncate">{agent.name}</span>
                      <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                        {agent.id}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </nav>

      {/* Session history — right after new chat */}
      {sessions.length > 0 && (
        <div className="session-list-scrollbar flex-1 overflow-y-auto overflow-x-hidden px-2 space-y-1 pb-2">
          <div ref={sessionSearchRef}>
            <div className="flex items-center justify-between gap-2 pb-1 pt-1.5 pl-1.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="truncate text-[12px] font-semibold tracking-[0.01em] text-muted-foreground">
                  {t('chat:recentTasks')}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-6 w-6 rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10',
                    groupByAgent && 'bg-black/10 text-foreground dark:bg-white/10'
                  )}
                  onClick={() => setGroupByAgent((prev) => !prev)}
                  aria-label={groupByAgent ? t('chat:ungroupSessions') : t('chat:groupByAgent')}
                  title={groupByAgent ? t('chat:ungroupSessions') : t('chat:groupByAgent')}
                >
                  <img src={groupIcon} alt="" className="h-3.5 w-3.5 shrink-0 opacity-80" />
                </Button>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                onClick={() => {
                  if (sessionSearchOpen && sessionSearchQuery) {
                    setSessionSearchQuery('');
                  }
                  setSessionSearchOpen((open) => !open);
                }}
                title={t('chat:searchHistory')}
              >
                <Search className="h-3.5 w-3.5" />
              </Button>
            </div>
            {sessionSearchOpen && (
              <div className="mb-1">
                <div className="relative flex h-8 w-full items-center gap-1.5 rounded-xl border border-black/10 bg-black/[0.02] px-2.5 pr-7 dark:border-white/10 dark:bg-white/[0.04]">
                  <Search className="h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    value={sessionSearchQuery}
                    onChange={(e) => setSessionSearchQuery(e.target.value)}
                    placeholder={t('chat:searchHistoryPlaceholder')}
                    className="h-full w-full bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                  {sessionSearchQuery && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0.5 h-7 w-7 rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                      onClick={() => setSessionSearchQuery('')}
                      title={t('common:actions.clear')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          {groupByAgent
            ? groupedSessions.map((group) => (
                <div key={group.agentId} className="mb-1">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">
                    {group.agentName}
                  </div>
                  {group.sessions.map((s) => renderSessionItem(s))}
                </div>
              ))
            : filteredSessions.map((s) => {
                return renderSessionItem(s, true);
              })}
        </div>
      )}

      {/* Quick Actions + Settings footer */}
      <div className="p-2 mt-auto">
        <div className="mb-1 rounded-xl border border-black/8 bg-black/[0.03] p-1 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {effectiveQuickRoutes.map((route) => {
                const item = quickActionByRoute[route];
                if (!item) return null;
                const isActive =
                  item.to === '__openclaw_external__' ? false : location.pathname === item.to;
                return (
                  <Tooltip key={item.to}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          if (item.to === '__openclaw_external__') {
                            void openDevConsole();
                            return;
                          }
                          navigate(item.to);
                        }}
                        className={cn(
                          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors [&>svg]:h-[18px] [&>svg]:w-[18px] [&>img]:h-[18px] [&>img]:w-[18px]',
                          isActive ? 'text-foreground' : 'text-foreground/72 hover:text-foreground'
                        )}
                      >
                        {item.icon}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-none whitespace-nowrap text-[12px]">
                      {item.label}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
            <div ref={quickMenuRef} className="relative shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
                    onClick={() => setQuickMenuOpen((open) => !open)}
                  >
                    <PlusCircle className="h-[18px] w-[18px]" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-none whitespace-nowrap text-[12px]">
                  {t('common:actions.add', '添加')}
                </TooltipContent>
              </Tooltip>
              {quickMenuOpen && (
                <div className="absolute bottom-full right-0 z-40 mb-2 w-48 rounded-xl border border-black/10 bg-white/95 p-1.5 shadow-lg dark:border-white/10 dark:bg-zinc-950/95">
                  {quickActionMenuItems.map((item) => {
                    const selected = effectiveQuickRoutes.includes(item.to);
                    const disabled = !selected && effectiveQuickRoutes.length >= 4;
                    return (
                      <button
                        key={item.to}
                        type="button"
                        onClick={() => {
                          toggleQuickRoute(item.to);
                        }}
                        disabled={disabled}
                        className={cn(
                          'mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors last:mb-0',
                          selected
                            ? 'bg-black/10 text-foreground dark:bg-white/10'
                            : 'text-foreground/80 hover:bg-black/5 dark:hover:bg-white/5',
                          disabled && 'cursor-not-allowed opacity-45'
                        )}
                      >
                        {item.icon}
                        <span className="flex-1 truncate">{item.label}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {selected ? '已添加' : '+'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <div ref={settingsMenuRef} className="relative">
        <button
          type="button"
          onClick={() => setSettingsMenuOpen((open) => !open)}
          className={cn(
            'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-[13px] font-medium transition-colors',
            'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
            settingsMenuOpen && 'bg-black/10 dark:bg-white/10 text-foreground'
          )}
        >
          <div
            className={cn(
              'flex shrink-0 items-center justify-center',
              settingsMenuOpen ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            <SettingsIcon className="h-[18px] w-[18px]" strokeWidth={2} />
          </div>
          <span className="flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap">
            {t('sidebar.settings')}
          </span>
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
              settingsMenuOpen && 'rotate-90'
            )}
          />
        </button>

        {settingsMenuOpen && (
          <div className="absolute bottom-full left-0 mb-2 min-w-[218px] overflow-hidden rounded-[20px] border border-black/10 bg-white/96 p-1 shadow-[0_14px_36px_rgba(15,23,42,0.12)] backdrop-blur dark:border-white/10 dark:bg-zinc-950/95">
            <div className="px-2.5 pb-1.5 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
              {t('sidebar.settings')}
            </div>
            <div className="space-y-0.5">
              {settingsItems.map((item) => {
                const isActive = location.pathname === item.to;
                return (
                  <div key={item.to}>
                    <button
                      type="button"
                      onClick={() => {
                        if (item.to === '__openclaw_external__') {
                          void openDevConsole();
                        } else {
                          navigate(item.to);
                        }
                        setSettingsMenuOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-[14px] px-2.5 py-1.5 text-left text-[12px] transition-colors',
                        isActive
                          ? 'bg-black/10 text-foreground dark:bg-white/10'
                          : 'text-foreground/82 hover:bg-black/[0.035] dark:hover:bg-white/5'
                      )}
                    >
                      <div
                        className={cn(
                          'flex h-5.5 w-5.5 shrink-0 items-center justify-center',
                          isActive ? 'text-foreground' : 'text-muted-foreground'
                        )}
                      >
                        {item.icon}
                      </div>
                      <span className="flex-1 truncate font-medium">{item.label}</span>
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/65" />
                    </button>
                    {item.to !== settingsItems[settingsItems.length - 1]?.to && (
                      <div className="mx-2.5 h-px bg-black/6 dark:bg-white/6" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!sessionToDelete}
        title={t('common:actions.confirm')}
        message={t('common:sidebar.deleteSessionConfirm', { label: sessionToDelete?.label })}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (!sessionToDelete) return;
          await deleteSession(sessionToDelete.key);
          if (currentSessionKey === sessionToDelete.key) navigate('/');
          setSessionToDelete(null);
        }}
        onCancel={() => setSessionToDelete(null)}
      />
    </aside>
  );
}

/** Windows: drag region with custom minimize/maximize/close controls */
function WindowsControlBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    invokeIpc('window:isMaximized').then((val) => {
      setMaximized(val as boolean);
    });
  }, []);

  const handleMinimize = () => {
    invokeIpc('window:minimize');
  };

  const handleMaximize = () => {
    invokeIpc('window:maximize').then(() => {
      invokeIpc('window:isMaximized').then((val) => {
        setMaximized(val as boolean);
      });
    });
  };

  const handleClose = () => {
    invokeIpc('window:close');
  };

  return (
    <div className="drag-region flex h-10 shrink-0 items-center justify-end">
      <div className="no-drag flex h-full">
        <button
          onClick={handleMinimize}
          className="flex h-full w-9 items-center justify-center text-muted-foreground hover:bg-accent transition-colors"
          title="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={handleMaximize}
          className="flex h-full w-9 items-center justify-center text-muted-foreground hover:bg-accent transition-colors"
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          onClick={handleClose}
          className="flex h-full w-9 items-center justify-center text-muted-foreground hover:bg-red-500 hover:text-white transition-colors"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
