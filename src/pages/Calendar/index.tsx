import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { hostApiFetch } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import {
  buildMonthGrid,
  formatLunarLabel,
  isSameMonth,
  sortCalendarEvents,
  toDateKey,
  type CalendarEvent,
  type CalendarEventColor,
} from '@/lib/calendar';
import { useCalendarStore, type CalendarEventInput } from '@/stores/calendar';
import type { CronJob } from '@/types/cron';

type EventFormState = CalendarEventInput;

const colorOptions: Array<{
  value: CalendarEventColor;
  label: string;
  dotClassName: string;
  softClassName: string;
}> = [
  {
    value: 'green',
    label: '薄荷绿',
    dotClassName: 'bg-emerald-500',
    softClassName: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  },
  {
    value: 'blue',
    label: '海盐蓝',
    dotClassName: 'bg-sky-500',
    softClassName: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
  },
  {
    value: 'violet',
    label: '暮光紫',
    dotClassName: 'bg-violet-500',
    softClassName: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
  },
  {
    value: 'rose',
    label: '晚霞粉',
    dotClassName: 'bg-rose-500',
    softClassName: 'bg-rose-500/12 text-rose-700 dark:text-rose-300',
  },
  {
    value: 'amber',
    label: '暖金',
    dotClassName: 'bg-amber-500',
    softClassName: 'bg-amber-500/14 text-amber-700 dark:text-amber-300',
  },
  {
    value: 'slate',
    label: '石墨灰',
    dotClassName: 'bg-slate-500',
    softClassName: 'bg-slate-500/12 text-slate-700 dark:text-slate-300',
  },
];

const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function getDefaultForm(date: string): EventFormState {
  return {
    title: '',
    date,
    startTime: '09:00',
    endTime: '10:00',
    allDay: false,
    color: 'green',
    notes: '',
  };
}

function formatMonthTitle(date: Date): string {
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
  });
}

function formatCellDate(date: Date, isCurrentMonth: boolean): string {
  if (!isCurrentMonth || date.getDate() === 1) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getDate()}日`;
}

function findColorMeta(color: CalendarEventColor) {
  return colorOptions.find((item) => item.value === color) || colorOptions[0];
}

interface EventEditorProps {
  open: boolean;
  mode: 'create' | 'edit';
  initialValue: EventFormState;
  onClose: () => void;
  onSubmit: (value: EventFormState) => void;
  onDelete?: () => void;
}

interface CalendarTaskItem {
  id: string;
  name: string;
  message: string;
  nextRun?: string;
  enabled: boolean;
}

interface SystemCalendarItem {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
}

interface SystemCalendarSyncResult {
  supported?: boolean;
  authorized?: boolean;
  events?: SystemCalendarItem[];
  error?: string;
}

type SystemCalendarCache = Record<string, SystemCalendarItem[]>;

const SYSTEM_CALENDAR_CACHE_KEY = 'calendar.system.events.cache.v1';

function getMonthCacheKey(date: Date): string {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`;
}

function readSystemCalendarCache(): SystemCalendarCache {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SYSTEM_CALENDAR_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as SystemCalendarCache;
  } catch {
    return {};
  }
}

function writeSystemCalendarCache(cache: SystemCalendarCache): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SYSTEM_CALENDAR_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore write failures (quota/privacy mode) and keep runtime behavior intact.
  }
}

interface DayListItem {
  id: string;
  kind: 'calendar' | 'system' | 'task';
  title: string;
  event?: CalendarEvent;
  systemEvent?: SystemCalendarItem;
  calendarName?: string;
}

interface SystemEventDetailProps {
  event: SystemCalendarItem | null;
  onClose: () => void;
}

function formatSystemEventDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function SystemEventDetail({ event, onClose }: SystemEventDetailProps) {
  if (!event) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-[10px] border border-black/8 bg-white p-5 dark:border-white/10 dark:bg-[#0f1720]"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[16px] font-semibold text-foreground">系统日历详情</div>
          <Button type="button" variant="ghost" size="sm" className="rounded-[8px]" onClick={onClose}>
            关闭
          </Button>
        </div>
        <div className="space-y-3 text-[13px]">
          <div className="rounded-[8px] border border-black/8 bg-white/70 p-3 dark:border-white/10 dark:bg-[#111b24]">
            <div className="mb-1 text-[12px] text-muted-foreground">标题</div>
            <div className="break-words text-foreground">{event.title || '（无标题）'}</div>
          </div>
          <div className="rounded-[8px] border border-black/8 bg-white/70 p-3 dark:border-white/10 dark:bg-[#111b24]">
            <div className="mb-1 text-[12px] text-muted-foreground">日历</div>
            <div className="text-foreground">{event.calendar || '系统日历'}</div>
          </div>
          <div className="rounded-[8px] border border-black/8 bg-white/70 p-3 dark:border-white/10 dark:bg-[#111b24]">
            <div className="mb-1 text-[12px] text-muted-foreground">开始</div>
            <div className="text-foreground">{formatSystemEventDateTime(event.start)}</div>
          </div>
          <div className="rounded-[8px] border border-black/8 bg-white/70 p-3 dark:border-white/10 dark:bg-[#111b24]">
            <div className="mb-1 text-[12px] text-muted-foreground">结束</div>
            <div className="text-foreground">{formatSystemEventDateTime(event.end)}</div>
          </div>
          <div className="text-[12px] text-muted-foreground">{event.allDay ? '全天事件' : '非全天事件'}</div>
        </div>
      </div>
    </div>
  );
}

function EventEditor({ open, mode, initialValue, onClose, onSubmit, onDelete }: EventEditorProps) {
  const [form, setForm] = useState<EventFormState>(initialValue);

  useEffect(() => {
    setForm(initialValue);
  }, [initialValue]);

  if (!open) return null;

  const handleSubmit = () => {
    const title = form.title.trim();
    if (!title) {
      toast.error('请填写日程标题');
      return;
    }
    if (!form.date) {
      toast.error('请选择日期');
      return;
    }
    if (!form.allDay && !form.startTime) {
      toast.error('请填写开始时间');
      return;
    }
    if (!form.allDay && form.startTime && form.endTime && form.endTime < form.startTime) {
      toast.error('结束时间不能早于开始时间');
      return;
    }
    onSubmit({
      ...form,
      title,
      notes: form.notes.trim(),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-[10px] border border-black/8 bg-white p-5 shadow-[0_30px_80px_-28px_rgba(15,23,42,0.42)] dark:border-white/10 dark:bg-[#0f1720]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <div>
            <div className="text-[16px] font-semibold tracking-tight text-foreground">
              {mode === 'create' ? '新建日程' : '编辑日程'}
            </div>
            <div className="mt-1 text-[12px] text-muted-foreground">本地保存，轻量一点，用起来更像系统日历。</div>
          </div>
          <Button type="button" variant="ghost" size="sm" className="rounded-[10px]" onClick={onClose}>
            关闭
          </Button>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>标题</Label>
            <Input
              autoFocus
              value={form.title}
              onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
              placeholder="例如：和客户过需求"
              className="h-10 rounded-[10px] border-black/8 bg-white dark:border-white/10 dark:bg-[#111b24]"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>日期</Label>
              <Input
                type="date"
                value={form.date}
                onChange={(event) => setForm((prev) => ({ ...prev, date: event.target.value }))}
                className="h-10 rounded-[10px] border-black/8 bg-white dark:border-white/10 dark:bg-[#111b24]"
              />
            </div>
            <div className="flex items-end">
              <div className="flex min-h-10 w-full items-center justify-between gap-2 rounded-[10px] border border-black/8 bg-white px-3 py-2 dark:border-white/10 dark:bg-[#111b24]">
                <span className="text-[12px] font-medium text-foreground/80">全天事件</span>
                <Switch
                  checked={form.allDay}
                  onCheckedChange={(checked) => setForm((prev) => ({ ...prev, allDay: checked }))}
                />
              </div>
            </div>
          </div>

          {!form.allDay && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label>开始时间</Label>
                <Input
                  type="time"
                  value={form.startTime || ''}
                  onChange={(event) => setForm((prev) => ({ ...prev, startTime: event.target.value }))}
                  className="h-10 rounded-[10px] border-black/8 bg-white dark:border-white/10 dark:bg-[#111b24]"
                />
              </div>
              <div className="space-y-2">
                <Label>结束时间</Label>
                <Input
                  type="time"
                  value={form.endTime || ''}
                  onChange={(event) => setForm((prev) => ({ ...prev, endTime: event.target.value }))}
                  className="h-10 rounded-[10px] border-black/8 bg-white dark:border-white/10 dark:bg-[#111b24]"
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>颜色</Label>
            <div className="grid grid-cols-3 gap-2">
              {colorOptions.map((item) => {
                const selected = form.color === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, color: item.value }))}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-[10px] border px-3 py-2 text-[12px] transition-colors',
                      selected
                        ? 'border-teal-500/25 bg-teal-500/[0.08] dark:border-teal-400/30 dark:bg-teal-500/[0.14]'
                        : 'border-black/8 bg-white hover:bg-black/[0.03] dark:border-white/10 dark:bg-[#111b24] dark:hover:bg-[#152130]',
                    )}
                  >
                    <span className={cn('h-2.5 w-2.5 rounded-full', item.dotClassName)} />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label>备注</Label>
            <Textarea
              value={form.notes}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              placeholder="补充会议地点、材料、提醒事项"
              className="min-h-[120px] rounded-[10px] border-black/8 bg-white dark:border-white/10 dark:bg-[#111b24]"
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between">
          {onDelete ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              删除
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" onClick={handleSubmit}>
            {mode === 'create' ? '保存日程' : '保存修改'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function CalendarPage() {
  const navigate = useNavigate();
  const events = useCalendarStore((state) => state.events);
  const createEvent = useCalendarStore((state) => state.createEvent);
  const updateEvent = useCalendarStore((state) => state.updateEvent);
  const deleteEvent = useCalendarStore((state) => state.deleteEvent);

  const [viewDate, setViewDate] = useState(() => new Date());
  const [selectedDateKey, setSelectedDateKey] = useState(() => toDateKey(new Date()));
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [summaryTab, setSummaryTab] = useState<'calendar' | 'task' | null>(null);
  const [taskItems, setTaskItems] = useState<CalendarTaskItem[]>([]);
  const [systemEvents, setSystemEvents] = useState<SystemCalendarItem[]>([]);
  const [syncingSystemCalendar, setSyncingSystemCalendar] = useState(false);
  const systemCalendarCacheRef = useRef<SystemCalendarCache>(readSystemCalendarCache());
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [selectedSystemEvent, setSelectedSystemEvent] = useState<SystemCalendarItem | null>(null);

  const monthGrid = useMemo(() => buildMonthGrid(viewDate), [viewDate]);
  const visibleMonthGrid = useMemo(() => {
    const lastWeek = monthGrid.slice(-7);
    const lastWeekHasCurrentMonthDay = lastWeek.some((date) => isSameMonth(date, viewDate));
    return lastWeekHasCurrentMonthDay ? monthGrid : monthGrid.slice(0, 35);
  }, [monthGrid, viewDate]);
  const monthLabel = useMemo(() => formatMonthTitle(viewDate), [viewDate]);
  const today = useMemo(() => new Date(), []);
  const todayKey = toDateKey(today);

  const normalizedQuery = query.trim().toLowerCase();
  const searchEventResults = useMemo(() => {
    if (!normalizedQuery) return [];
    return sortCalendarEvents(
      events.filter((event) => {
        const haystack = `${event.title}\n${event.notes}\n${event.date}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      }),
    );
  }, [events, normalizedQuery]);

  const visibleEvents = normalizedQuery ? searchEventResults : events;
  const visibleEventsByDate = useMemo(() => {
    return visibleEvents.reduce<Record<string, CalendarEvent[]>>((result, event) => {
      if (!result[event.date]) result[event.date] = [];
      result[event.date]?.push(event);
      return result;
    }, {});
  }, [visibleEvents]);
  const visibleTaskItems = useMemo(() => {
    const source = normalizedQuery
      ? taskItems.filter((task) => `${task.name}\n${task.message}`.toLowerCase().includes(normalizedQuery))
      : taskItems;
    return source;
  }, [normalizedQuery, taskItems]);
  const visibleTasksByDate = useMemo(() => {
    return visibleTaskItems.reduce<Record<string, CalendarTaskItem[]>>((result, task) => {
      if (!task.nextRun) return result;
      const date = new Date(task.nextRun);
      if (Number.isNaN(date.getTime())) return result;
      const dateKey = toDateKey(date);
      if (!result[dateKey]) result[dateKey] = [];
      result[dateKey]?.push(task);
      return result;
    }, {});
  }, [visibleTaskItems]);
  const visibleSystemEventsByDate = useMemo(() => {
    const source = normalizedQuery
      ? systemEvents.filter((event) =>
          `${event.title}\n${event.calendar}`.toLowerCase().includes(normalizedQuery),
        )
      : systemEvents;
    return source.reduce<Record<string, SystemCalendarItem[]>>((result, event) => {
      const date = new Date(event.start);
      if (Number.isNaN(date.getTime())) return result;
      const dateKey = toDateKey(date);
      if (!result[dateKey]) result[dateKey] = [];
      result[dateKey]?.push(event);
      return result;
    }, {});
  }, [normalizedQuery, systemEvents]);
  const editorInitialValue = editingEvent
    ? {
        title: editingEvent.title,
        date: editingEvent.date,
        startTime: editingEvent.startTime,
        endTime: editingEvent.endTime,
        allDay: editingEvent.allDay,
        color: editingEvent.color,
        notes: editingEvent.notes,
      }
    : getDefaultForm(selectedDateKey);

  const monthLocalEventCount = events.filter((event) => {
    const currentMonth = startMonthKey(viewDate);
    return event.date.startsWith(currentMonth);
  }).length;
  const monthSystemEventCount = systemEvents.filter((event) => {
    const date = new Date(event.start);
    if (Number.isNaN(date.getTime())) return false;
    return isSameMonth(date, viewDate);
  }).length;
  const monthEventCount = monthLocalEventCount + monthSystemEventCount;
  const monthTaskCount = taskItems.filter((task) => {
    if (!task.nextRun) return false;
    const nextRun = new Date(task.nextRun);
    if (Number.isNaN(nextRun.getTime())) return false;
    return isSameMonth(nextRun, viewDate);
  }).length;

  useEffect(() => {
    let cancelled = false;
    const loadTaskStats = async () => {
      try {
        const jobs = await hostApiFetch<CronJob[]>('/api/cron/jobs');
        if (cancelled || !Array.isArray(jobs)) return;
        const nextTaskItems: CalendarTaskItem[] = jobs.map((job) => ({
          id: job.id,
          name: job.name?.trim() || '未命名任务',
          message: job.message?.trim() || '',
          nextRun: job.nextRun,
          enabled: job.enabled !== false,
        }));
        setTaskItems(nextTaskItems);
      } catch {
        if (!cancelled) {
          setTaskItems([]);
        }
      }
    };
    void loadTaskStats();
    return () => {
      cancelled = true;
    };
  }, []);

  const syncSystemCalendar = useCallback(
    async (targetDate: Date, options?: { silent?: boolean }) => {
      const month = getMonthCacheKey(targetDate);
      setSyncingSystemCalendar(true);
      try {
        const result = await hostApiFetch<SystemCalendarSyncResult>(
          `/api/system-calendar/events?month=${month}`,
        );
        const supported = result?.supported !== false;
        const authorized = result?.authorized ?? null;
        const events = Array.isArray(result?.events) ? result.events : [];

        if (!supported) {
          if (!options?.silent) {
            toast.message('当前系统不支持系统日历同步');
          }
          return;
        }

        if (authorized === false) {
          if (!options?.silent) {
            toast.error('系统日历权限未授权，请先在系统设置中允许后重试');
          }
          return;
        }

        setSystemEvents(events);
        const nextCache: SystemCalendarCache = {
          ...systemCalendarCacheRef.current,
          [month]: events,
        };
        systemCalendarCacheRef.current = nextCache;
        writeSystemCalendarCache(nextCache);
        if (!options?.silent) {
          toast.success(`系统日历已同步（${events.length} 项）`);
        }
      } catch {
        if (!options?.silent) {
          toast.error('同步失败，请在系统设置 > 隐私与安全性 > 日历里允许“阿山”访问后重试');
        }
      } finally {
        setSyncingSystemCalendar(false);
      }
    },
    [],
  );

  useEffect(() => {
    const month = getMonthCacheKey(viewDate);
    const cached = systemCalendarCacheRef.current[month];
    setSystemEvents(Array.isArray(cached) ? cached : []);
    void syncSystemCalendar(viewDate, { silent: true });
  }, [syncSystemCalendar, viewDate]);

  const handleOpenCreate = (dateKey = selectedDateKey) => {
    setSelectedDateKey(dateKey);
    setEditingEvent(null);
    setEditorOpen(true);
  };

  const handleSubmitEvent = (value: EventFormState) => {
    if (editingEvent) {
      updateEvent(editingEvent.id, value);
      toast.success('日程已更新');
    } else {
      createEvent(value);
      toast.success('日程已创建');
    }
    setSelectedDateKey(value.date);
    setEditorOpen(false);
    setEditingEvent(null);
  };

  const handleDeleteEvent = () => {
    if (!editingEvent) return;
    deleteEvent(editingEvent.id);
    toast.success('日程已删除');
    setEditorOpen(false);
    setEditingEvent(null);
  };

  const handleToggleSummaryTab = (tab: 'calendar' | 'task') => {
    setSummaryTab((prev) => (prev === tab ? null : tab));
  };

  return (
    <div className="min-h-[calc(100vh-2.5rem)] overflow-y-auto -m-6 bg-[#f3f5f4] dark:bg-[#0b1117]">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 p-5 pb-8 pt-6 md:p-7 md:pb-10">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 pb-1">
            <h1 className="shrink-0 text-[40px] font-semibold tracking-tight text-foreground md:text-[56px]">
              {monthLabel}
            </h1>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button
                type="button"
                size="icon"
                className="h-11 w-11 rounded-full"
                onClick={() => handleOpenCreate()}
                title="新建日程"
              >
                <Plus className="h-4.5 w-4.5" />
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 rounded-full border-black/8 bg-white dark:border-white/10 dark:bg-[#111821]"
                  onClick={() => setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 rounded-full border-black/8 bg-white px-4 text-[15px] font-medium dark:border-white/10 dark:bg-[#111821]"
                  onClick={() => {
                    const now = new Date();
                    setViewDate(now);
                    setSelectedDateKey(toDateKey(now));
                  }}
                >
                  今
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 rounded-full border-black/8 bg-white dark:border-white/10 dark:bg-[#111821]"
                  onClick={() => setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 rounded-full border-black/8 bg-white dark:border-white/10 dark:bg-[#111821]"
                  onClick={() => {
                    void syncSystemCalendar(viewDate);
                  }}
                  title="同步系统日历"
                  disabled={syncingSystemCalendar}
                >
                  <RefreshCw className={cn('h-4 w-4', syncingSystemCalendar && 'animate-spin')} />
                </Button>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center rounded-[10px] border border-black/8 bg-white p-1 dark:border-white/10 dark:bg-[#111821]">
                <button
                  type="button"
                  onClick={() => handleToggleSummaryTab('calendar')}
                  className={cn(
                    'h-8 rounded-[8px] px-4 text-[12px] font-medium transition-colors',
                    summaryTab === 'calendar'
                      ? 'bg-black/15 text-foreground shadow-sm dark:bg-white/20'
                      : 'text-foreground/70 hover:bg-black/5 dark:hover:bg-white/6',
                  )}
                >
                  日程
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleSummaryTab('task')}
                  className={cn(
                    'h-8 rounded-[8px] px-4 text-[12px] font-medium transition-colors',
                    summaryTab === 'task'
                      ? 'bg-black/15 text-foreground shadow-sm dark:bg-white/20'
                      : 'text-foreground/70 hover:bg-black/5 dark:hover:bg-white/6',
                  )}
                >
                  任务
                </button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-10 w-10 rounded-full border-black/8 bg-white dark:border-white/10 dark:bg-[#111821]"
                onClick={() => {
                  setSearchOpen((prev) => !prev);
                  if (searchOpen) {
                    setQuery('');
                  }
                }}
                title="搜索"
              >
                <Search className="h-4 w-4" />
              </Button>
              {searchOpen && (
                <div className="flex items-center gap-2">
                  <div className="relative w-[220px] md:w-[280px]">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索日程"
                      className="h-10 rounded-[10px] border-black/8 bg-white pl-9 dark:border-white/10 dark:bg-[#111821]"
                    />
                  </div>
                  {normalizedQuery && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-9 rounded-[8px] px-2.5 text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => setQuery('')}
                    >
                      取消筛选
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
              {(summaryTab === null || summaryTab === 'calendar') && (
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="h-3.5 w-3.5" />
                  本月 {monthEventCount} 项日程
                </span>
              )}
              {(summaryTab === null || summaryTab === 'task') && (
                <span className="inline-flex items-center gap-1.5">
                  <Clock3 className="h-3.5 w-3.5" />
                  {monthTaskCount} 项任务
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-[10px] border border-black/[0.06] bg-white dark:border-white/[0.08] dark:bg-[#111821]">
          <div className="grid grid-cols-7 border-b border-black/[0.06] dark:border-white/[0.08]">
            {weekdayLabels.map((label) => (
              <div
                key={label}
                className="flex h-10 items-center justify-center border-r border-black/[0.06] text-[12px] font-normal text-foreground/72 last:border-r-0 dark:border-white/[0.08] md:h-11 md:text-[13px]"
              >
                {label}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7">
            {visibleMonthGrid.map((date, index) => {
              const dateKey = toDateKey(date);
              const dayEvents = sortCalendarEvents(visibleEventsByDate[dateKey] || []);
              const dayTasks = visibleTasksByDate[dateKey] || [];
              const daySystemEvents = visibleSystemEventsByDate[dateKey] || [];
              const dayItems: DayListItem[] = [];
              if (summaryTab !== 'task') {
                dayItems.push(
                  ...dayEvents.map((event) => ({
                    id: `event-${event.id}`,
                    kind: 'calendar' as const,
                    title: event.title,
                    event,
                  })),
                );
                dayItems.push(
                  ...daySystemEvents.map((event) => ({
                    id: `system-${event.id}`,
                    kind: 'system' as const,
                    title: event.title,
                    systemEvent: event,
                    calendarName: event.calendar,
                  })),
                );
              }
              if (summaryTab !== 'calendar') {
                dayItems.push(
                  ...dayTasks.map((task) => ({
                    id: `task-${task.id}`,
                    kind: 'task' as const,
                    title: task.name,
                  })),
                );
              }
              const isCurrentMonth = isSameMonth(date, viewDate);
              const isSelected = dateKey === selectedDateKey;
              const isToday = dateKey === todayKey;
              const previousDate = index > 0 ? monthGrid[index - 1] : undefined;
              const lunarLabel = formatLunarLabel(date, previousDate);

              return (
                <button
                  key={dateKey}
                  type="button"
                  onClick={() => {
                    setSelectedDateKey(dateKey);
                    if (!isCurrentMonth) {
                      setViewDate(new Date(date.getFullYear(), date.getMonth(), 1));
                    }
                  }}
                  onDoubleClick={() => handleOpenCreate(dateKey)}
                  className={cn(
                    'relative flex min-h-[70px] cursor-pointer flex-col border-r border-t border-black/[0.06] px-2 py-1.5 text-left transition-colors duration-150 last:border-r-0 dark:border-white/[0.08] md:min-h-[76px] md:px-2 md:py-1.5',
                    index < 7 && 'border-t-0',
                    isSelected
                      ? 'bg-[#fbfcfd] dark:bg-[#141d26]'
                      : 'bg-white hover:bg-[#fbfbfa] dark:bg-[#111821] dark:hover:bg-[#141d26]',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span
                        className={cn(
                          'text-[11px] font-normal leading-none md:text-[12px]',
                          isCurrentMonth ? 'text-foreground/50' : 'text-foreground/30 dark:text-foreground/24',
                        )}
                      >
                        {lunarLabel}
                      </span>
                      <span
                        className={cn(
                          'text-[13px] font-normal leading-none md:text-[14px]',
                          isCurrentMonth ? 'text-foreground/92' : 'text-foreground/30 dark:text-foreground/24',
                        )}
                      >
                        {formatCellDate(date, isCurrentMonth)}
                      </span>
                    </div>
                    {isToday && (
                      <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-[#ff3b30] px-1 text-[13px] font-semibold leading-none text-white md:h-7 md:min-w-7 md:text-[14px]">
                        {date.getDate()}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 space-y-0.5">
                    {dayItems.slice(0, 2).map((item) => {
                      const color = item.kind === 'calendar' && item.event
                        ? findColorMeta(item.event.color)
                        : item.kind === 'system'
                          ? { dotClassName: 'bg-purple-500' }
                          : { dotClassName: 'bg-orange-500' };
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={(eventMouse) => {
                            eventMouse.stopPropagation();
                            if (item.kind === 'calendar' && item.event) {
                              setSelectedDateKey(item.event.date);
                              setEditingEvent(item.event);
                              setEditorOpen(true);
                              return;
                            }
                            if (item.kind === 'task') {
                              navigate('/cron');
                              return;
                            }
                            if (item.kind === 'system' && item.systemEvent) {
                              setSelectedSystemEvent(item.systemEvent);
                            }
                          }}
                          className="flex w-full cursor-pointer items-start gap-1.5 text-left"
                          title={
                            item.kind === 'task'
                              ? '打开任务管理'
                              : item.kind === 'system' && item.calendarName
                                ? `系统日历：${item.calendarName}`
                                : undefined
                          }
                        >
                          <span className={cn('mt-0.5 h-3.5 w-[3px] shrink-0 rounded-full', color.dotClassName)} />
                          <span
                            className={cn(
                              'line-clamp-1 text-[10.5px] font-normal leading-4 md:text-[11px]',
                              isCurrentMonth
                                ? 'text-foreground/88'
                                : 'text-foreground/34 dark:text-foreground/26',
                            )}
                          >
                            {item.title}
                          </span>
                        </button>
                      );
                    })}
                    {dayItems.length > 2 && (
                      <div
                        className={cn(
                          'pl-2 text-[10px] font-normal',
                          isCurrentMonth
                            ? 'text-muted-foreground'
                            : 'text-foreground/32 dark:text-foreground/24',
                        )}
                      >
                        +{dayItems.length - 2}个
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <EventEditor
        open={editorOpen}
        mode={editingEvent ? 'edit' : 'create'}
        initialValue={editorInitialValue}
        onClose={() => {
          setEditorOpen(false);
          setEditingEvent(null);
        }}
        onSubmit={handleSubmitEvent}
        onDelete={editingEvent ? handleDeleteEvent : undefined}
      />
      <SystemEventDetail
        event={selectedSystemEvent}
        onClose={() => {
          setSelectedSystemEvent(null);
        }}
      />
    </div>
  );
}

function startMonthKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${year}-${month}`;
}
