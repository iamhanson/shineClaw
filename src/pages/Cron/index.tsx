/**
 * Cron Page
 * Manage scheduled tasks
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Plus,
  Clock,
  Play,
  Trash2,
  RefreshCw,
  X,
  Calendar,
  AlertCircle,
  CheckCircle2,
  XCircle,
  MessageSquare,
  Loader2,
  Timer,
  History,
  Pause,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useCronStore } from '@/stores/cron';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { formatRelativeTime, cn } from '@/lib/utils';
import { hostApiFetch } from '@/lib/host-api';
import { toast } from 'sonner';
import type { CronJob, CronJobCreateInput, ScheduleType } from '@/types/cron';
import { CHANNEL_ICONS, type ChannelType } from '@/types/channel';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// Common cron schedule presets
const schedulePresets: { key: string; value: string; type: ScheduleType }[] = [
  { key: 'everyMinute', value: '* * * * *', type: 'interval' },
  { key: 'every5Min', value: '*/5 * * * *', type: 'interval' },
  { key: 'every15Min', value: '*/15 * * * *', type: 'interval' },
  { key: 'everyHour', value: '0 * * * *', type: 'interval' },
  { key: 'daily9am', value: '0 9 * * *', type: 'daily' },
  { key: 'daily6pm', value: '0 18 * * *', type: 'daily' },
  { key: 'weeklyMon', value: '0 9 * * 1', type: 'weekly' },
  { key: 'monthly1st', value: '0 9 1 * *', type: 'monthly' },
];

const SKILL_DIRECTIVE_BLOCK_REGEX =
  /^\s*\[skill_directive id="([^"]+)"(?: name="([^"]*)")?\]\n[\s\S]*?\n\[\/skill_directive\]\s*/i;

function parseMessageSkillDirective(rawMessage: unknown): { skillId: string | null; message: string } {
  const normalizedMessage = typeof rawMessage === 'string' ? rawMessage : '';
  const match = normalizedMessage.match(SKILL_DIRECTIVE_BLOCK_REGEX);
  if (!match) {
    return { skillId: null, message: normalizedMessage };
  }
  const skillId = match[1] || null;
  const cleanedMessage = normalizedMessage.replace(SKILL_DIRECTIVE_BLOCK_REGEX, '').trimStart();
  return { skillId, message: cleanedMessage };
}

function buildMessageWithSkillDirective(
  message: string,
  skill: { id: string; name: string } | null,
): string {
  const baseMessage = message.trim();
  if (!skill) return baseMessage;
  const safeName = skill.name.replace(/"/g, "'");
  return `[skill_directive id="${skill.id}" name="${safeName}"]
Use skill "${safeName}" (id: ${skill.id}) for this task.
[/skill_directive]

${baseMessage}`;
}

// Parse cron schedule to human-readable format
// Handles both plain cron strings and Gateway CronSchedule objects:
//   { kind: "cron", expr: "...", tz?: "..." }
//   { kind: "every", everyMs: number }
//   { kind: "at", at: "..." }
function parseCronSchedule(schedule: unknown, t: TFunction<'cron'>): string {
  // Handle Gateway CronSchedule object format
  if (schedule && typeof schedule === 'object') {
    const s = schedule as {
      kind?: string;
      expr?: string;
      tz?: string;
      everyMs?: number;
      at?: string;
    };
    if (s.kind === 'cron' && typeof s.expr === 'string') {
      return parseCronExpr(s.expr, t);
    }
    if (s.kind === 'every' && typeof s.everyMs === 'number') {
      const ms = s.everyMs;
      if (ms < 60_000) return t('schedule.everySeconds', { count: Math.round(ms / 1000) });
      if (ms < 3_600_000) return t('schedule.everyMinutes', { count: Math.round(ms / 60_000) });
      if (ms < 86_400_000) return t('schedule.everyHours', { count: Math.round(ms / 3_600_000) });
      return t('schedule.everyDays', { count: Math.round(ms / 86_400_000) });
    }
    if (s.kind === 'at' && typeof s.at === 'string') {
      try {
        return t('schedule.onceAt', { time: new Date(s.at).toLocaleString() });
      } catch {
        return t('schedule.onceAt', { time: s.at });
      }
    }
    return String(schedule);
  }

  // Handle plain cron string
  if (typeof schedule === 'string') {
    return parseCronExpr(schedule, t);
  }

  return String(schedule ?? t('schedule.unknown'));
}

// Parse a plain cron expression string to human-readable text
function parseCronExpr(cron: string, t: TFunction<'cron'>): string {
  const preset = schedulePresets.find((p) => p.value === cron);
  if (preset) return t(`presets.${preset.key}` as const);

  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts;

  if (minute === '*' && hour === '*') return t('presets.everyMinute');
  if (minute.startsWith('*/'))
    return t('schedule.everyMinutes', { count: Number(minute.slice(2)) });
  if (hour === '*' && minute === '0') return t('presets.everyHour');
  if (dayOfWeek !== '*' && dayOfMonth === '*') {
    return t('schedule.weeklyAt', { day: dayOfWeek, time: `${hour}:${minute.padStart(2, '0')}` });
  }
  if (dayOfMonth !== '*') {
    return t('schedule.monthlyAtDay', {
      day: dayOfMonth,
      time: `${hour}:${minute.padStart(2, '0')}`,
    });
  }
  if (hour !== '*') {
    return t('schedule.dailyAt', { time: `${hour}:${minute.padStart(2, '0')}` });
  }

  return cron;
}

function estimateNextRun(scheduleExpr: string): string | null {
  const now = new Date();
  const next = new Date(now.getTime());

  if (scheduleExpr === '* * * * *') {
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);
    return next.toLocaleString();
  }

  if (scheduleExpr === '*/5 * * * *') {
    const delta = 5 - (next.getMinutes() % 5 || 5);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + delta);
    return next.toLocaleString();
  }

  if (scheduleExpr === '*/15 * * * *') {
    const delta = 15 - (next.getMinutes() % 15 || 15);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + delta);
    return next.toLocaleString();
  }

  if (scheduleExpr === '0 * * * *') {
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next.toLocaleString();
  }

  if (scheduleExpr === '0 9 * * *' || scheduleExpr === '0 18 * * *') {
    const targetHour = scheduleExpr === '0 9 * * *' ? 9 : 18;
    next.setSeconds(0, 0);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toLocaleString();
  }

  if (scheduleExpr === '0 9 * * 1') {
    next.setSeconds(0, 0);
    next.setHours(9, 0, 0, 0);
    const day = next.getDay();
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
    next.setDate(next.getDate() + daysUntilMonday);
    return next.toLocaleString();
  }

  if (scheduleExpr === '0 9 1 * *') {
    next.setSeconds(0, 0);
    next.setDate(1);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setMonth(next.getMonth() + 1);
    return next.toLocaleString();
  }

  return null;
}

// Create/Edit Task Dialog
interface TaskDialogProps {
  job?: CronJob;
  onClose: () => void;
  onSave: (input: CronJobCreateInput) => Promise<void>;
}

interface ChannelAccountItem {
  accountId: string;
  name: string;
  configured: boolean;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  isDefault: boolean;
  agentId?: string;
  defaultRecipientId?: string;
  recipientOptions?: string[];
}

interface ChannelGroupItem {
  channelType: string;
  defaultAccountId?: string;
  accounts: ChannelAccountItem[];
}

function TaskDialog({ job, onClose, onSave }: TaskDialogProps) {
  const { t } = useTranslation('cron');
  const [saving, setSaving] = useState(false);
  const skills = useSkillsStore((s) => s.skills);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const parsedJobMessage = useMemo(
    () => parseMessageSkillDirective(job?.message || ''),
    [job?.message]
  );

  const [name, setName] = useState(job?.name || '');
  const [message, setMessage] = useState(parsedJobMessage.message);
  const [selectedSkillId, setSelectedSkillId] = useState<string>(parsedJobMessage.skillId || '');
  // Extract cron expression string from CronSchedule object or use as-is if string
  const initialSchedule = (() => {
    const s = job?.schedule;
    if (!s) return '0 9 * * *';
    if (typeof s === 'string') return s;
    if (typeof s === 'object' && 'expr' in s && typeof (s as { expr: string }).expr === 'string') {
      return (s as { expr: string }).expr;
    }
    return '0 9 * * *';
  })();
  const [schedule, setSchedule] = useState(initialSchedule);
  const [customSchedule, setCustomSchedule] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [targetChannelType, setTargetChannelType] = useState(job?.target?.channelType || '');
  const [targetAccountId, setTargetAccountId] = useState(job?.target?.accountId || '');
  const [targetRecipientId, setTargetRecipientId] = useState(job?.target?.recipientId || '');
  const [showCustomRecipientInput, setShowCustomRecipientInput] = useState(false);
  const [channelOptions, setChannelOptions] = useState<
    Array<{
      id: string;
      label: string;
      agentIds: string[];
      primaryAgentId?: string;
      defaultAccountId?: string;
      accounts: ChannelAccountItem[];
    }>
  >([]);
  const selectedChannelOption = useMemo(
    () => channelOptions.find((item) => item.id === targetChannelType),
    [channelOptions, targetChannelType]
  );
  const selectedTargetAccount = useMemo(() => {
    if (!selectedChannelOption) return null;
    const preferred = selectedChannelOption.accounts.find((account) => account.accountId === targetAccountId);
    if (preferred) return preferred;
    const fallbackDefault = selectedChannelOption.accounts.find(
      (account) => account.accountId === selectedChannelOption.defaultAccountId
    );
    return fallbackDefault || selectedChannelOption.accounts[0] || null;
  }, [selectedChannelOption, targetAccountId]);
  const configuredRecipientOptions = useMemo(() => {
    if (!selectedTargetAccount) return [];
    const options = new Set<string>();
    if (selectedTargetAccount.defaultRecipientId) {
      options.add(selectedTargetAccount.defaultRecipientId);
    }
    for (const candidate of selectedTargetAccount.recipientOptions || []) {
      const value = candidate?.trim();
      if (value) options.add(value);
    }
    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [selectedTargetAccount]);
  const recipientOptions = useMemo(() => {
    const options = new Set(configuredRecipientOptions);
    const current = targetRecipientId.trim();
    if (current) options.add(current);
    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [configuredRecipientOptions, targetRecipientId]);
  const resolvedAgentId = selectedTargetAccount?.agentId || selectedChannelOption?.primaryAgentId || 'main';
  const schedulePreview = estimateNextRun(useCustom ? customSchedule : schedule);
  const selectableSkills = useMemo(
    () =>
      (Array.isArray(skills) ? skills : [])
        .filter((skill) => skill.enabled)
        .sort((a, b) => {
          const sourceRank = (source: string | undefined): number => {
            const normalized = (source || '').toLowerCase();
            if (normalized.includes('workspace')) return 0;
            if (!normalized.includes('bundled')) return 1;
            return 2;
          };
          const rankDiff = sourceRank(a.source) - sourceRank(b.source);
          if (rankDiff !== 0) return rankDiff;
          return a.name.localeCompare(b.name);
        }),
    [skills]
  );
  const selectedSkill = useMemo(
    () => selectableSkills.find((skill) => skill.id === selectedSkillId) ?? null,
    [selectableSkills, selectedSkillId]
  );

  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

  useEffect(() => {
    const loadOptions = async () => {
      try {
        const response = await hostApiFetch<{ success: boolean; channels?: ChannelGroupItem[] }>(
          '/api/cron/channel-options'
        );
        const options = (response.channels || [])
          .map((group: ChannelGroupItem) => {
            const agentIds = Array.from(
              new Set(
                group.accounts
                  .map((account) => account.agentId?.trim())
                  .filter((value): value is string => Boolean(value))
              )
            );
            const defaultAccount = group.accounts.find(
              (account) => account.accountId === group.defaultAccountId
            );
            const primaryAgentId =
              defaultAccount?.agentId ||
              agentIds[0] ||
              undefined;
            return {
              id: group.channelType,
              label: group.channelType,
              agentIds,
              primaryAgentId,
              defaultAccountId: group.defaultAccountId,
              accounts: group.accounts,
            };
          })
          .filter((item) => Boolean(item.id));
        setChannelOptions(options);
      } catch {
        setChannelOptions([]);
      }
    };
    void loadOptions();
  }, []);

  useEffect(() => {
    if (!targetChannelType || !selectedChannelOption) {
      if (targetAccountId) setTargetAccountId('');
      if (!job?.target?.recipientId && targetRecipientId) setTargetRecipientId('');
      setShowCustomRecipientInput(false);
      return;
    }

    const preferred = selectedChannelOption.accounts.find((account) => account.accountId === targetAccountId);
    const fallback =
      selectedChannelOption.accounts.find((account) => account.accountId === selectedChannelOption.defaultAccountId)
      || selectedChannelOption.accounts[0];
    const nextAccount = preferred || fallback;
    if (nextAccount && nextAccount.accountId !== targetAccountId) {
      setTargetAccountId(nextAccount.accountId);
    }
    if (!job?.target?.recipientId && !targetRecipientId && nextAccount?.defaultRecipientId) {
      setTargetRecipientId(nextAccount.defaultRecipientId);
    }
  }, [job?.target?.recipientId, selectedChannelOption, targetAccountId, targetChannelType, targetRecipientId]);

  useEffect(() => {
    const current = targetRecipientId.trim();
    if (!current) {
      setShowCustomRecipientInput(false);
      return;
    }
    if (!configuredRecipientOptions.includes(current)) {
      setShowCustomRecipientInput(true);
    }
  }, [configuredRecipientOptions, targetRecipientId]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error(t('toast.nameRequired'));
      return;
    }
    if (!message.trim()) {
      toast.error(t('toast.messageRequired'));
      return;
    }

    const finalSchedule = useCustom ? customSchedule : schedule;
    if (!finalSchedule.trim()) {
      toast.error(t('toast.scheduleRequired'));
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        message: buildMessageWithSkillDirective(message.trim(), selectedSkill),
        schedule: finalSchedule,
        agentId: targetChannelType ? resolvedAgentId : 'main',
        targetChannelType: (targetChannelType as ChannelType) || undefined,
        targetAccountId: targetChannelType ? (targetAccountId || undefined) : undefined,
        targetRecipientId: targetChannelType ? (targetRecipientId.trim() || undefined) : undefined,
        enabled,
      });
      onClose();
      toast.success(job ? t('toast.updated') : t('toast.created'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-xl border-0 shadow-2xl bg-card dark:bg-card overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between pb-2 shrink-0">
          <div>
            <CardTitle className="text-2xl font-heading font-normal">
              {job ? t('dialog.editTitle') : t('dialog.createTitle')}
            </CardTitle>
            <CardDescription className="text-[15px] mt-1 text-foreground/70">
              {t('dialog.description')}
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
          {/* Name */}
          <div className="space-y-2.5">
            <Label htmlFor="name" className="text-[14px] text-foreground/80 font-bold">
              {t('dialog.taskName')}
            </Label>
            <Input
              id="name"
              placeholder={t('dialog.taskNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-[44px] rounded-xl font-mono text-[13px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-sm transition-all text-foreground placeholder:text-foreground/40"
            />
          </div>

          {/* Message */}
          <div className="space-y-2.5">
            <Label htmlFor="message" className="text-[14px] text-foreground/80 font-bold">
              {t('dialog.message')}
            </Label>
            <Textarea
              id="message"
              placeholder={t('dialog.messagePlaceholder')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="rounded-xl font-mono text-[13px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-sm transition-all text-foreground placeholder:text-foreground/40 resize-none"
            />
          </div>

          {/* Skill */}
          <div className="space-y-2.5">
            <Label htmlFor="skill" className="text-[14px] text-foreground/80 font-bold">
              {t('dialog.skill')}
            </Label>
            <select
              id="skill"
              value={selectedSkillId}
              onChange={(e) => setSelectedSkillId(e.target.value)}
              className="h-[44px] w-full rounded-xl px-3 font-mono text-[13px] bg-muted dark:bg-muted border border-black/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary text-foreground"
            >
              <option value="">{t('dialog.skillNone')}</option>
              {selectableSkills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.name} ({skill.id})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2.5">
            <Label htmlFor="target-channel" className="text-[14px] text-foreground/80 font-bold">
              投递 Channel
            </Label>
            <select
              id="target-channel"
              value={targetChannelType}
              onChange={(e) => {
                setTargetChannelType(e.target.value);
                setTargetAccountId('');
                if (!job?.target?.recipientId) {
                  setTargetRecipientId('');
                }
              }}
              className="h-[44px] w-full rounded-xl px-3 font-mono text-[13px] bg-muted dark:bg-muted border border-black/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary text-foreground"
            >
              <option value="">应用内会话</option>
              {channelOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            {targetChannelType && selectedChannelOption && (
              <>
                <Label htmlFor="target-account" className="mt-2 block text-[13px] text-foreground/70">
                  账号
                </Label>
                <select
                  id="target-account"
                  value={selectedTargetAccount?.accountId || ''}
                  onChange={(e) => {
                    const accountId = e.target.value;
                    setTargetAccountId(accountId);
                    const matched = selectedChannelOption.accounts.find((account) => account.accountId === accountId);
                    if (!job?.target?.recipientId) {
                      setTargetRecipientId(matched?.defaultRecipientId || '');
                    }
                    setShowCustomRecipientInput(false);
                  }}
                  className="h-[40px] w-full rounded-xl px-3 font-mono text-[13px] bg-muted dark:bg-muted border border-black/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary text-foreground"
                >
                  {selectedChannelOption.accounts.map((account) => (
                    <option key={account.accountId} value={account.accountId}>
                      {account.name} ({account.accountId})
                    </option>
                  ))}
                </select>
                <Label htmlFor="target-recipient-id" className="mt-2 block text-[13px] text-foreground/70">
                  接收人 ID（可选）
                </Label>
                <div className="flex gap-2">
                  <select
                    id="target-recipient-id"
                    value={recipientOptions.includes(targetRecipientId.trim()) ? targetRecipientId.trim() : ''}
                    onChange={(e) => {
                      setTargetRecipientId(e.target.value);
                      if (e.target.value) {
                        setShowCustomRecipientInput(false);
                      }
                    }}
                    className="h-[40px] w-full rounded-xl px-3 font-mono text-[13px] bg-muted dark:bg-muted border border-black/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary text-foreground"
                  >
                    <option value="">选择接收人 ID（可选）</option>
                    {recipientOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-[40px] rounded-xl px-3 shrink-0"
                    onClick={() => setShowCustomRecipientInput((prev) => !prev)}
                  >
                    手动输入
                  </Button>
                </div>
                {showCustomRecipientInput && (
                  <Input
                    value={targetRecipientId}
                    onChange={(e) => setTargetRecipientId(e.target.value)}
                    placeholder="例如：ou_xxx（飞书）"
                    className="h-[40px] rounded-xl font-mono text-[13px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-sm transition-all text-foreground placeholder:text-foreground/40"
                  />
                )}
                <p className="text-[12px] text-muted-foreground">
                  候选项来自 openclaw.json 中该账号的接收人配置（如 `defaultRecipientId`、`allowFrom`）。
                </p>
              </>
            )}
            {!targetChannelType && (
              <p className="text-[12px] text-muted-foreground">
                当前对应 Agent：main（应用内会话）
              </p>
            )}
            {targetChannelType && selectedChannelOption && (
              <p className="text-[12px] text-muted-foreground">
                当前对应 Agent：
                {resolvedAgentId || '未绑定（将使用 main）'}
              </p>
            )}
          </div>

          {/* Schedule */}
          <div className="space-y-2.5">
            <Label className="text-[14px] text-foreground/80 font-bold">
              {t('dialog.schedule')}
            </Label>
            {!useCustom ? (
              <div className="grid grid-cols-2 gap-2">
                {schedulePresets.map((preset) => (
                  <Button
                    key={preset.value}
                    type="button"
                    variant={schedule === preset.value ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSchedule(preset.value)}
                    className={cn(
                      'justify-start h-10 rounded-xl font-medium text-[13px] transition-all',
                      schedule === preset.value
                        ? 'bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm border-transparent'
                        : 'bg-muted dark:bg-muted border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80 hover:text-foreground'
                    )}
                  >
                    <Timer className="h-4 w-4 mr-2 opacity-70" />
                    {t(`presets.${preset.key}` as const)}
                  </Button>
                ))}
              </div>
            ) : (
              <Input
                placeholder={t('dialog.cronPlaceholder')}
                value={customSchedule}
                onChange={(e) => setCustomSchedule(e.target.value)}
                className="h-[44px] rounded-xl font-mono text-[13px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-sm transition-all text-foreground placeholder:text-foreground/40"
              />
            )}
            <div className="flex items-center justify-between mt-2">
              <p className="text-[12px] text-muted-foreground/80 font-medium">
                {schedulePreview
                  ? `${t('card.next')}: ${schedulePreview}`
                  : t('dialog.cronPlaceholder')}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setUseCustom(!useCustom)}
                className="text-[12px] h-7 px-2 text-foreground/60 hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 rounded-lg"
              >
                {useCustom ? t('dialog.usePresets') : t('dialog.useCustomCron')}
              </Button>
            </div>
          </div>

          {/* Enabled */}
          <div className="flex items-center justify-between bg-muted dark:bg-muted p-4 rounded-2xl shadow-sm border border-black/5 dark:border-white/5">
            <div>
              <Label className="text-[14px] text-foreground/80 font-bold">
                {t('dialog.enableImmediately')}
              </Label>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                {t('dialog.enableImmediatelyDesc')}
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4">
            <Button
              variant="outline"
              onClick={onClose}
              className="rounded-full px-6 h-[42px] text-[13px] font-semibold border-black/20 dark:border-white/20 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80 hover:text-foreground shadow-sm"
            >
              {t('common:actions.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={saving}
              className="rounded-full px-6 h-[42px] text-[13px] font-semibold shadow-sm border border-transparent transition-all"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('common:status.saving', 'Saving...')}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  {job ? t('dialog.saveChanges') : t('dialog.createTitle')}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Job Card Component
interface CronJobCardProps {
  job: CronJob;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onTrigger: () => Promise<void>;
}

function CronJobCard({ job, onToggle, onEdit, onDelete, onTrigger }: CronJobCardProps) {
  const { t } = useTranslation('cron');
  const [triggering, setTriggering] = useState(false);
  const cleanedMessage = useMemo(() => parseMessageSkillDirective(job.message).message, [job.message]);

  const handleTrigger = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setTriggering(true);
    try {
      await onTrigger();
      toast.success(t('toast.triggered'));
    } catch (error) {
      console.error('Failed to trigger cron job:', error);
      toast.error(
        t('toast.failedTrigger', { error: error instanceof Error ? error.message : String(error) })
      );
    } finally {
      setTriggering(false);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  return (
    <div
      className="group flex flex-col px-3 py-3 rounded-lg bg-transparent hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-all relative overflow-hidden cursor-pointer"
      onClick={onEdit}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 shrink-0 flex items-center justify-center text-foreground bg-black/5 dark:bg-white/5 rounded-full">
            <Clock
              className={cn('h-4 w-4', job.enabled ? 'text-foreground' : 'text-muted-foreground')}
            />
          </div>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-[16px] font-semibold text-foreground truncate">{job.name}</h3>
              <div
                className={cn(
                  'w-2 h-2 rounded-full shrink-0',
                  job.enabled ? 'bg-green-500' : 'bg-muted-foreground'
                )}
                title={job.enabled ? t('stats.active') : t('stats.paused')}
              />
            </div>
            <p className="text-[13px] text-muted-foreground flex items-center gap-1.5">
              <Timer className="h-3.5 w-3.5" />
              {parseCronSchedule(job.schedule, t)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Switch checked={job.enabled} onCheckedChange={onToggle} />
        </div>
      </div>

      <div className="flex-1 flex flex-col justify-end pl-12">
        <div className="flex items-start gap-2 mb-1.5">
          <MessageSquare className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
          <p className="text-[13.5px] text-muted-foreground line-clamp-2 leading-[1.5]">
            {cleanedMessage}
          </p>
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground/80 font-medium mb-1.5">
          <span className="flex items-center gap-1.5">
            <span>🤖</span>
            {job.agentId || 'main'}
          </span>

          {job.target && (
            <span className="flex items-center gap-1.5">
              {CHANNEL_ICONS[job.target.channelType as ChannelType]}
              {job.target.channelName}
            </span>
          )}
          {job.target?.accountId && (
            <span className="flex items-center gap-1.5">
              账号: {job.target.accountId}
            </span>
          )}
          {job.target?.recipientId && (
            <span className="flex items-center gap-1.5">
              接收人: {job.target.recipientId}
            </span>
          )}
          {!job.target && (
            <span className="flex items-center gap-1.5">
              <MessageSquare className="h-3.5 w-3.5" />
              应用内会话
            </span>
          )}

          {job.lastRun && (
            <span className="flex items-center gap-1.5">
              <History className="h-3.5 w-3.5" />
              {t('card.last')}: {formatRelativeTime(job.lastRun.time)}
              {job.lastRun.success ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-red-500" />
              )}
            </span>
          )}

          {job.nextRun && job.enabled && (
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              {t('card.next')}: {new Date(job.nextRun).toLocaleString()}
            </span>
          )}
        </div>

        {/* Last Run Error */}
        {job.lastRun && !job.lastRun.success && job.lastRun.error && (
          <div className="flex items-start gap-2 p-2.5 mb-3 rounded-xl bg-destructive/10 border border-destructive/20 text-[13px] text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span className="line-clamp-2">{job.lastRun.error}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity mt-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleTrigger}
            disabled={triggering}
            className="h-8 px-3 text-foreground/70 hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 rounded-lg text-[13px] font-medium transition-colors"
          >
            {triggering ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <Play className="h-3.5 w-3.5 mr-1.5" />
            )}
            {t('card.runNow')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            className="h-8 px-3 text-destructive/70 hover:text-destructive hover:bg-destructive/10 rounded-lg text-[13px] font-medium transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            {t('common:actions.delete', 'Delete')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Cron() {
  const { t } = useTranslation('cron');
  const {
    jobs,
    loading,
    error,
    fetchJobs,
    createJob,
    updateJob,
    toggleJob,
    deleteJob,
    triggerJob,
  } = useCronStore();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [showDialog, setShowDialog] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | undefined>();
  const [jobToDelete, setJobToDelete] = useState<{ id: string } | null>(null);

  const isGatewayRunning = gatewayStatus.state === 'running';

  // Fetch jobs on mount
  useEffect(() => {
    if (isGatewayRunning) {
      fetchJobs();
    }
  }, [fetchJobs, isGatewayRunning]);

  // Statistics
  const safeJobs = Array.isArray(jobs) ? jobs : [];
  const activeJobs = safeJobs.filter((j) => j.enabled);
  const pausedJobs = safeJobs.filter((j) => !j.enabled);
  const failedJobs = safeJobs.filter((j) => j.lastRun && !j.lastRun.success);

  const handleSave = useCallback(
    async (input: CronJobCreateInput) => {
      if (editingJob) {
        await updateJob(editingJob.id, input);
      } else {
        await createJob(input);
      }
    },
    [editingJob, createJob, updateJob]
  );

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await toggleJob(id, enabled);
        toast.success(enabled ? t('toast.enabled') : t('toast.paused'));
      } catch {
        toast.error(t('toast.failedUpdate'));
      }
    },
    [toggleJob, t]
  );

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
        {/* Header */}
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
              onClick={fetchJobs}
              disabled={!isGatewayRunning}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-2" />
              {t('refresh')}
            </Button>
            <Button
              onClick={() => {
                setEditingJob(undefined);
                setShowDialog(true);
              }}
              disabled={!isGatewayRunning}
              className="h-9 text-[13px] font-medium rounded-full px-4 shadow-none"
            >
              <Plus className="h-3.5 w-3.5 mr-2" />
              {t('newTask')}
            </Button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2">
          {/* Gateway Warning */}
          {!isGatewayRunning && (
            <div className="mb-8 p-4 rounded-xl border border-yellow-500/50 bg-yellow-500/10 flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
              <span className="text-yellow-700 dark:text-yellow-400 text-sm font-medium">
                {t('gatewayWarning')}
              </span>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="mb-8 p-4 rounded-xl border border-destructive/50 bg-destructive/10 flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-destructive" />
              <span className="text-destructive text-sm font-medium">{error}</span>
            </div>
          )}

          {/* Statistics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <div className="p-4 rounded-xl bg-black/5 dark:bg-white/5 border border-transparent flex items-center gap-3 group hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <div className="h-9 w-9 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
                <Clock className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-[22px] leading-none font-heading text-foreground">
                  {safeJobs.length}
                </p>
                <p className="text-[12px] font-medium text-muted-foreground mt-1">
                  {t('stats.total')}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-black/5 dark:bg-white/5 border border-transparent flex items-center gap-3 group hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <div className="h-9 w-9 shrink-0 rounded-full bg-green-500/10 flex items-center justify-center">
                <Play className="h-4 w-4 text-green-600 dark:text-green-500 ml-0.5" />
              </div>
              <div>
                <p className="text-[22px] leading-none font-heading text-foreground">
                  {activeJobs.length}
                </p>
                <p className="text-[12px] font-medium text-muted-foreground mt-1">
                  {t('stats.active')}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-black/5 dark:bg-white/5 border border-transparent flex items-center gap-3 group hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <div className="h-9 w-9 shrink-0 rounded-full bg-yellow-500/10 flex items-center justify-center">
                <Pause className="h-4 w-4 text-yellow-600 dark:text-yellow-500" />
              </div>
              <div>
                <p className="text-[22px] leading-none font-heading text-foreground">
                  {pausedJobs.length}
                </p>
                <p className="text-[12px] font-medium text-muted-foreground mt-1">
                  {t('stats.paused')}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-black/5 dark:bg-white/5 border border-transparent flex items-center gap-3 group hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <div className="h-9 w-9 shrink-0 rounded-full bg-destructive/10 flex items-center justify-center">
                <XCircle className="h-4 w-4 text-destructive" />
              </div>
              <div>
                <p className="text-[22px] leading-none font-heading text-foreground">
                  {failedJobs.length}
                </p>
                <p className="text-[12px] font-medium text-muted-foreground mt-1">
                  {t('stats.failed')}
                </p>
              </div>
            </div>
          </div>

          {/* Jobs List */}
          {safeJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-muted-foreground bg-black/5 dark:bg-white/5 rounded-xl border border-transparent border-dashed">
              <Clock className="h-8 w-8 mb-3 opacity-50" />
              <h3 className="text-lg font-medium mb-2 text-foreground">{t('empty.title')}</h3>
              <p className="text-[14px] text-center mb-6 max-w-md">{t('empty.description')}</p>
              <Button
                onClick={() => {
                  setEditingJob(undefined);
                  setShowDialog(true);
                }}
                disabled={!isGatewayRunning}
                className="rounded-full px-6 h-10"
              >
                <Plus className="h-4 w-4 mr-2" />
                {t('empty.create')}
              </Button>
            </div>
          ) : (
            <div className="space-y-0">
              {safeJobs.map((job) => (
                <CronJobCard
                  key={job.id}
                  job={job}
                  onToggle={(enabled) => handleToggle(job.id, enabled)}
                  onEdit={() => {
                    setEditingJob(job);
                    setShowDialog(true);
                  }}
                  onDelete={() => setJobToDelete({ id: job.id })}
                  onTrigger={() => triggerJob(job.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create/Edit Dialog */}
      {showDialog && (
        <TaskDialog
          job={editingJob}
          onClose={() => {
            setShowDialog(false);
            setEditingJob(undefined);
          }}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        open={!!jobToDelete}
        title={t('common:actions.confirm', 'Confirm')}
        message={t('card.deleteConfirm')}
        confirmLabel={t('common:actions.delete', 'Delete')}
        cancelLabel={t('common:actions.cancel', 'Cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (jobToDelete) {
            await deleteJob(jobToDelete.id);
            setJobToDelete(null);
            toast.success(t('toast.deleted'));
          }
        }}
        onCancel={() => setJobToDelete(null)}
      />
    </div>
  );
}

export default Cron;
