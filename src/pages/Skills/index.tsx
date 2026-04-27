/**
 * Skills Page
 * Browse and manage AI skills
 */
import { useEffect, useState, useCallback } from 'react';
import {
  Search,
  Puzzle,
  Lock,
  Package,
  X,
  AlertCircle,
  Plus,
  Key,
  Trash2,
  RefreshCw,
  FolderOpen,
  FileCode,
  Globe,
  Copy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useSkillsStore } from '@/stores/skills';
import { useGatewayStore } from '@/stores/gateway';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { toast } from 'sonner';
import type { Skill } from '@/types/skill';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// Skill detail dialog component
interface SkillDetailDialogProps {
  skill: Skill | null;
  isOpen: boolean;
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
  onUninstall?: (slug: string) => void;
  onOpenFolder?: (skill: Skill) => Promise<void> | void;
}

function resolveSkillSourceLabel(skill: Skill, t: TFunction<'skills'>): string {
  const source = (skill.source || '').trim().toLowerCase();
  if (!source) {
    if (skill.isBundled) return t('source.badge.bundled', { defaultValue: 'Bundled' });
    return t('source.badge.unknown', { defaultValue: 'Unknown source' });
  }
  if (source === 'openclaw-bundled') return t('source.badge.bundled', { defaultValue: 'Bundled' });
  if (source === 'openclaw-managed') return t('source.badge.managed', { defaultValue: 'Managed' });
  if (source === 'openclaw-workspace')
    return t('source.badge.workspace', { defaultValue: 'Workspace' });
  if (source === 'openclaw-extra') return t('source.badge.extra', { defaultValue: 'Extra dirs' });
  if (source === 'agents-skills-personal')
    return t('source.badge.agentsPersonal', { defaultValue: 'Personal .agents' });
  if (source === 'agents-skills-project')
    return t('source.badge.agentsProject', { defaultValue: 'Project .agents' });
  return source;
}

function SkillDetailDialog({
  skill,
  isOpen,
  onClose,
  onToggle,
  onUninstall,
  onOpenFolder,
}: SkillDetailDialogProps) {
  const { t } = useTranslation('skills');
  const { fetchSkills } = useSkillsStore();
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [apiKey, setApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Initialize config from skill
  useEffect(() => {
    if (!skill) return;

    // API Key
    if (skill.config?.apiKey) {
      setApiKey(String(skill.config.apiKey));
    } else {
      setApiKey('');
    }

    // Env Vars
    if (skill.config?.env) {
      const vars = Object.entries(skill.config.env).map(([key, value]) => ({
        key,
        value: String(value),
      }));
      setEnvVars(vars);
    } else {
      setEnvVars([]);
    }
  }, [skill]);

  const handleOpenClawhub = async () => {
    if (!skill?.slug) return;
    await invokeIpc('shell:openExternal', `https://clawhub.ai/s/${skill.slug}`);
  };

  const handleOpenEditor = async () => {
    if (!skill?.id) return;
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>(
        '/api/clawhub/open-readme',
        {
          method: 'POST',
          body: JSON.stringify({ skillKey: skill.id, slug: skill.slug, baseDir: skill.baseDir }),
        }
      );
      if (result.success) {
        toast.success(t('toast.openedEditor'));
      } else {
        toast.error(result.error || t('toast.failedEditor'));
      }
    } catch (err) {
      toast.error(t('toast.failedEditor') + ': ' + String(err));
    }
  };

  const handleCopyPath = async () => {
    if (!skill?.baseDir) return;
    try {
      await navigator.clipboard.writeText(skill.baseDir);
      toast.success(t('toast.copiedPath'));
    } catch (err) {
      toast.error(t('toast.failedCopyPath') + ': ' + String(err));
    }
  };

  const handleAddEnv = () => {
    setEnvVars([...envVars, { key: '', value: '' }]);
  };

  const handleUpdateEnv = (index: number, field: 'key' | 'value', value: string) => {
    const newVars = [...envVars];
    newVars[index] = { ...newVars[index], [field]: value };
    setEnvVars(newVars);
  };

  const handleRemoveEnv = (index: number) => {
    const newVars = [...envVars];
    newVars.splice(index, 1);
    setEnvVars(newVars);
  };

  const handleSaveConfig = async () => {
    if (isSaving || !skill) return;
    setIsSaving(true);
    try {
      // Build env object, filtering out empty keys
      const envObj = envVars.reduce(
        (acc, curr) => {
          const key = curr.key.trim();
          const value = curr.value.trim();
          if (key) {
            acc[key] = value;
          }
          return acc;
        },
        {} as Record<string, string>
      );

      // Use direct file access instead of Gateway RPC for reliability
      const result = (await invokeIpc<{ success: boolean; error?: string }>('skill:updateConfig', {
        skillKey: skill.id,
        apiKey: apiKey || '', // Empty string will delete the key
        env: envObj, // Empty object will clear all env vars
      })) as { success: boolean; error?: string };

      if (!result.success) {
        throw new Error(result.error || 'Unknown error');
      }

      // Refresh skills from gateway to get updated config
      await fetchSkills();

      toast.success(t('detail.configSaved'));
    } catch (err) {
      toast.error(t('toast.failedSave') + ': ' + String(err));
    } finally {
      setIsSaving(false);
    }
  };

  if (!skill) return null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="flex w-full flex-col border-l border-black/10 bg-card p-0 shadow-[0_0_40px_rgba(0,0,0,0.2)] dark:border-white/10 dark:bg-card sm:max-w-[450px]"
        side="right"
      >
        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto bg-[linear-gradient(180deg,rgba(16,185,129,0.05),transparent_18%)] px-8 py-10 dark:bg-[linear-gradient(180deg,rgba(16,185,129,0.08),transparent_18%)]">
          <div className="mb-8 flex flex-col items-center rounded-xl border border-black/7 bg-white/70 p-6 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.45)] dark:border-white/10 dark:bg-white/[0.04]">
            <div className="mb-4 flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-black/7 bg-white shadow-sm dark:border-white/10 dark:bg-accent relative">
              <span className="text-3xl">{skill.icon || '🔧'}</span>
              {skill.isCore && (
                <div className="absolute -bottom-1 -right-1 rounded-full border border-black/5 bg-card p-1 shadow-sm dark:border-white/5 dark:bg-card">
                  <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                </div>
              )}
            </div>
            <h2 className="text-[28px] font-heading text-foreground font-normal mb-3 text-center tracking-tight">
              {skill.name}
            </h2>
            <div className="flex items-center justify-center gap-2.5 mb-6 opacity-80">
              <Badge
                variant="secondary"
                className="font-mono text-[11px] font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] border-0 shadow-none text-foreground/70 transition-colors"
              >
                v{skill.version}
              </Badge>
              <Badge
                variant="secondary"
                className="font-mono text-[11px] font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] border-0 shadow-none text-foreground/70 transition-colors"
              >
                {skill.isCore
                  ? t('detail.coreSystem')
                  : skill.isBundled
                    ? t('detail.bundled')
                    : t('detail.userInstalled')}
              </Badge>
            </div>

            {skill.description && (
              <p className="text-[14px] text-foreground/70 font-medium leading-[1.6] text-center px-4">
                {skill.description}
              </p>
            )}
          </div>

          <div className="space-y-6 px-1">
            <div className="space-y-2 rounded-xl border border-black/7 bg-white/72 p-4 dark:border-white/8 dark:bg-white/[0.04]">
              <h3 className="text-[13px] font-bold text-foreground/80">{t('detail.source')}</h3>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] border-0 shadow-none text-foreground/70"
                >
                  {resolveSkillSourceLabel(skill, t)}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={skill.baseDir || t('detail.pathUnavailable')}
                  readOnly
                  className="h-[38px] font-mono text-[12px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 rounded-xl text-foreground/70"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-[38px] w-[38px] border-black/10 dark:border-white/10"
                  disabled={!skill.baseDir}
                  onClick={handleCopyPath}
                  title={t('detail.copyPath')}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-[38px] w-[38px] border-black/10 dark:border-white/10"
                  disabled={!skill.baseDir}
                  onClick={() => onOpenFolder?.(skill)}
                  title={t('detail.openActualFolder')}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* API Key Section */}
            {!skill.isCore && (
              <div className="space-y-2 rounded-xl border border-black/7 bg-white/72 p-4 dark:border-white/8 dark:bg-white/[0.04]">
                <h3 className="text-[13px] font-bold flex items-center gap-2 text-foreground/80">
                  <Key className="h-3.5 w-3.5 text-blue-500" />
                  {t('detail.apiKey')}
                </h3>
                <Input
                  placeholder={t('detail.apiKeyPlaceholder', 'Enter API Key (optional)')}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  type="password"
                  className="h-[44px] font-mono text-[13px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 rounded-xl focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-sm transition-all text-foreground placeholder:text-foreground/40"
                />
                <p className="text-[12px] text-foreground/50 mt-2 font-medium">
                  {t(
                    'detail.apiKeyDesc',
                    'The primary API key for this skill. Leave blank if not required or configured elsewhere.'
                  )}
                </p>
              </div>
            )}

            {/* Environment Variables Section */}
            {!skill.isCore && (
              <div className="space-y-3 rounded-xl border border-black/7 bg-white/72 p-4 dark:border-white/8 dark:bg-white/[0.04]">
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[13px] font-bold text-foreground/80">
                      {t('detail.envVars')}
                      {envVars.length > 0 && (
                        <Badge
                          variant="secondary"
                          className="ml-2 px-1.5 py-0 text-[10px] h-5 bg-black/10 dark:bg-white/10 text-foreground"
                        >
                          {envVars.length}
                        </Badge>
                      )}
                    </h3>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[12px] font-semibold text-foreground/80 gap-1.5 px-2.5 hover:bg-black/5 dark:hover:bg-white/5"
                    onClick={handleAddEnv}
                  >
                    <Plus className="h-3 w-3" strokeWidth={3} />
                    {t('detail.addVariable', 'Add Variable')}
                  </Button>
                </div>

                <div className="space-y-2">
                  {envVars.length === 0 && (
                    <div className="text-[13px] text-foreground/50 font-medium italic flex items-center bg-muted dark:bg-muted border border-black/5 dark:border-white/5 rounded-xl px-4 py-3 shadow-sm">
                      {t('detail.noEnvVars', 'No environment variables configured.')}
                    </div>
                  )}

                  {envVars.map((env, index) => (
                    <div className="flex items-center gap-3" key={index}>
                      <Input
                        value={env.key}
                        onChange={(e) => handleUpdateEnv(index, 'key', e.target.value)}
                        className="flex-1 h-[40px] font-mono text-[13px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 rounded-xl focus-visible:ring-2 focus-visible:ring-primary/50 shadow-sm text-foreground"
                        placeholder={t('detail.keyPlaceholder', 'Key')}
                      />
                      <Input
                        value={env.value}
                        onChange={(e) => handleUpdateEnv(index, 'value', e.target.value)}
                        className="flex-1 h-[40px] font-mono text-[13px] bg-muted dark:bg-muted border-black/10 dark:border-white/10 rounded-xl focus-visible:ring-2 focus-visible:ring-primary/50 shadow-sm text-foreground"
                        placeholder={t('detail.valuePlaceholder', 'Value')}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 text-destructive/70 hover:text-destructive hover:bg-destructive/10 shrink-0 rounded-xl transition-colors"
                        onClick={() => handleRemoveEnv(index)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* External Links */}
            {skill.slug && !skill.isBundled && !skill.isCore && (
              <div className="flex gap-2 justify-center pt-8">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-[28px] text-[11px] font-medium px-3 gap-1.5 rounded-full border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/70"
                  onClick={handleOpenClawhub}
                >
                  <Globe className="h-[12px] w-[12px]" />
                  ClawHub
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-[28px] text-[11px] font-medium px-3 gap-1.5 rounded-full border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/70"
                  onClick={handleOpenEditor}
                >
                  <FileCode className="h-[12px] w-[12px]" />
                  {t('detail.openManual')}
                </Button>
              </div>
            )}
          </div>

          {/* Centered Footer Buttons */}
          <div className="pt-8 pb-4 flex items-center justify-center gap-4 w-full px-2 max-w-[340px] mx-auto">
            {!skill.isCore && (
              <Button
                onClick={handleSaveConfig}
                className={cn(
                  'flex-1 h-[42px] text-[13px] rounded-full font-semibold shadow-sm border border-transparent transition-all',
                  'bg-primary hover:bg-primary/90 text-white'
                )}
                disabled={isSaving}
              >
                {isSaving ? t('detail.saving') : t('detail.saveConfig')}
              </Button>
            )}

            {!skill.isCore && (
              <Button
                variant="outline"
                className="flex-1 h-[42px] text-[13px] rounded-full font-semibold shadow-sm bg-transparent border-black/20 dark:border-white/20 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-foreground/80 hover:text-foreground"
                onClick={() => {
                  if (!skill.isBundled && onUninstall && skill.slug) {
                    onUninstall(skill.slug);
                    onClose();
                  } else {
                    onToggle(!skill.enabled);
                  }
                }}
              >
                {!skill.isBundled && onUninstall
                  ? t('detail.uninstall')
                  : skill.enabled
                    ? t('detail.disable')
                    : t('detail.enable')}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function Skills() {
  const {
    skills,
    loading,
    error,
    fetchSkills,
    enableSkill,
    disableSkill,
    searchResults,
    searchSkills,
    installSkill,
    uninstallSkill,
    searching,
    searchError,
    installing,
  } = useSkillsStore();
  const { t } = useTranslation('skills');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [searchQuery, setSearchQuery] = useState('');
  const [installQuery, setInstallQuery] = useState('');
  const [marketplaceSource, setMarketplaceSource] = useState<'clawhub' | 'tencent'>('clawhub');
  const [installSheetOpen, setInstallSheetOpen] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [selectedSource, setSelectedSource] = useState<'all' | 'built-in' | 'marketplace'>('all');

  const isGatewayRunning = gatewayStatus.state === 'running';
  const [showGatewayWarning, setShowGatewayWarning] = useState(false);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (!isGatewayRunning) {
      timer = setTimeout(() => {
        setShowGatewayWarning(true);
      }, 1500);
    } else {
      timer = setTimeout(() => {
        setShowGatewayWarning(false);
      }, 0);
    }
    return () => clearTimeout(timer);
  }, [isGatewayRunning]);

  useEffect(() => {
    if (isGatewayRunning) {
      fetchSkills();
    }
  }, [fetchSkills, isGatewayRunning]);

  const safeSkills = Array.isArray(skills) ? skills : [];
  const filteredSkills = safeSkills
    .filter((skill) => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        q.length === 0 ||
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.id.toLowerCase().includes(q) ||
        (skill.slug || '').toLowerCase().includes(q) ||
        (skill.author || '').toLowerCase().includes(q);

      let matchesSource = true;
      if (selectedSource === 'built-in') {
        matchesSource = !!skill.isBundled;
      } else if (selectedSource === 'marketplace') {
        matchesSource = !skill.isBundled;
      }

      return matchesSearch && matchesSource;
    })
    .sort((a, b) => {
      if (a.enabled && !b.enabled) return -1;
      if (!a.enabled && b.enabled) return 1;
      if (a.isCore && !b.isCore) return -1;
      if (!a.isCore && b.isCore) return 1;
      return a.name.localeCompare(b.name);
    });

  const sourceStats = {
    all: safeSkills.length,
    builtIn: safeSkills.filter((s) => s.isBundled).length,
    marketplace: safeSkills.filter((s) => !s.isBundled).length,
  };

  const handleToggle = useCallback(
    async (skillId: string, enable: boolean) => {
      try {
        if (enable) {
          await enableSkill(skillId);
          toast.success(t('toast.enabled'));
        } else {
          await disableSkill(skillId);
          toast.success(t('toast.disabled'));
        }
      } catch (err) {
        toast.error(String(err));
      }
    },
    [enableSkill, disableSkill, t]
  );

  const hasInstalledSkills = safeSkills.some((s) => !s.isBundled);

  const handleOpenSkillsFolder = useCallback(async () => {
    try {
      const skillsDir = await invokeIpc<string>('openclaw:getSkillsDir');
      if (!skillsDir) {
        throw new Error('Skills directory not available');
      }
      const result = await invokeIpc<string>('shell:openPath', skillsDir);
      if (result) {
        if (
          result.toLowerCase().includes('no such file') ||
          result.toLowerCase().includes('not found') ||
          result.toLowerCase().includes('failed to open')
        ) {
          toast.error(t('toast.failedFolderNotFound'));
        } else {
          throw new Error(result);
        }
      }
    } catch (err) {
      toast.error(t('toast.failedOpenFolder') + ': ' + String(err));
    }
  }, [t]);

  const handleOpenSkillFolder = useCallback(
    async (skill: Skill) => {
      try {
        const result = await hostApiFetch<{ success: boolean; error?: string }>(
          '/api/clawhub/open-path',
          {
            method: 'POST',
            body: JSON.stringify({
              skillKey: skill.id,
              slug: skill.slug,
              baseDir: skill.baseDir,
            }),
          }
        );
        if (!result.success) {
          throw new Error(result.error || 'Failed to open folder');
        }
      } catch (err) {
        toast.error(t('toast.failedOpenActualFolder') + ': ' + String(err));
      }
    },
    [t]
  );

  const [skillsDirPath, setSkillsDirPath] = useState('~/.openclaw/skills');

  useEffect(() => {
    invokeIpc<string>('openclaw:getSkillsDir')
      .then((dir) => setSkillsDirPath(dir as string))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!installSheetOpen) {
      return;
    }

    const query = installQuery.trim();
    if (query.length === 0) {
      searchSkills('', marketplaceSource);
      return;
    }

    const timer = setTimeout(() => {
      searchSkills(query, marketplaceSource);
    }, 300);
    return () => clearTimeout(timer);
  }, [installQuery, installSheetOpen, marketplaceSource, searchSkills]);

  const handleInstall = useCallback(
    async (slug: string) => {
      try {
        await installSkill(slug, undefined, marketplaceSource);
        await enableSkill(slug);
        toast.success(t('toast.installed'));
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (['installTimeoutError', 'installRateLimitError'].includes(errorMessage)) {
          toast.error(t(`toast.${errorMessage}`, { path: skillsDirPath }), { duration: 10000 });
        } else {
          toast.error(t('toast.failedInstall') + ': ' + errorMessage);
        }
      }
    },
    [installSkill, marketplaceSource, enableSkill, t, skillsDirPath]
  );

  const handleUninstall = useCallback(
    async (slug: string) => {
      try {
        await uninstallSkill(slug);
        toast.success(t('toast.uninstalled'));
      } catch (err) {
        toast.error(t('toast.failedUninstall') + ': ' + String(err));
      }
    },
    [uninstallSkill, t]
  );

  if (loading) {
    return (
      <div className="flex min-h-[calc(100vh-2.5rem)] flex-col items-center justify-center -m-6 dark:bg-background">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-2.5rem)] overflow-y-auto bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.10),_transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.68),rgba(255,255,255,0))] -m-6 dark:bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.12),_transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))]">
      <div className="mx-auto flex w-full max-w-6xl flex-col p-8 pb-10 pt-10 md:p-10 md:pb-12 md:pt-12">
        {/* Header */}
        <div className="mb-6 flex shrink-0 flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <h1 className="mb-2 text-[28px] font-heading font-normal tracking-tight text-foreground md:text-[36px]">
              {t('title')}
            </h1>
            <p className="text-[15px] font-medium text-foreground/70">{t('subtitle')}</p>
          </div>

          <div className="flex items-center gap-3 md:mt-2">
            {hasInstalledSkills && (
              <button
                onClick={handleOpenSkillsFolder}
                className="flex h-10 shrink-0 items-center justify-center rounded-full border border-black/10 px-4 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-black/5 hover:text-foreground dark:border-white/10 dark:hover:bg-white/5"
              >
                <FolderOpen className="mr-2 h-4 w-4" />
                {t('openFolder')}
              </button>
            )}
          </div>
        </div>

        {/* Gateway Warning */}
        {showGatewayWarning && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-4">
            <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
            <span className="text-yellow-700 dark:text-yellow-400 text-sm font-medium">
              {t('gatewayWarning')}
            </span>
          </div>
        )}

        <div className="rounded-xl border border-black/7 bg-white/60 p-3 shadow-[0_18px_45px_-35px_rgba(15,23,42,0.45)] dark:border-white/10 dark:bg-white/[0.03]">
          {/* Sub Navigation and Actions */}
          <div className="flex flex-col gap-3 px-1 pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <div className="relative flex min-w-0 flex-1 items-center rounded-full border border-transparent bg-black/5 px-3 py-2 transition-colors focus-within:border-black/10 focus-within:bg-black/10 dark:bg-white/5 dark:focus-within:border-white/10">
                  <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <input
                    placeholder={t('search')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="ml-2 min-w-0 flex-1 bg-transparent text-[13px] font-normal text-foreground outline-none placeholder:text-foreground/50"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="ml-1 shrink-0 text-foreground/50 hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={fetchSkills}
                  disabled={!isGatewayRunning}
                  className="h-9 w-9 rounded-full border-black/10 bg-transparent text-muted-foreground shadow-none hover:bg-black/5 hover:text-foreground dark:border-white/10 dark:hover:bg-white/5"
                  title={t('refresh')}
                >
                  <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setInstallQuery('');
                    setInstallSheetOpen(true);
                  }}
                  className="h-9 rounded-full border-black/10 bg-transparent px-4 text-[13px] font-medium shadow-none hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
                >
                  {t('actions.installSkill')}
                </Button>
              </div>
            </div>

            <div className="flex items-center flex-wrap gap-4 text-[14px]">
              <div className="flex items-center gap-2 rounded-full border border-black/7 bg-background/80 p-1 dark:border-white/8 dark:bg-background/60">
                <button
                  onClick={() => setSelectedSource('all')}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium transition-colors',
                    selectedSource === 'all'
                      ? 'bg-black/10 text-foreground dark:bg-white/10'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t('filter.all', { count: sourceStats.all })}
                </button>
                <button
                  onClick={() => setSelectedSource('built-in')}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium transition-colors',
                    selectedSource === 'built-in'
                      ? 'bg-black/10 text-foreground dark:bg-white/10'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t('filter.builtIn', { count: sourceStats.builtIn })}
                </button>
                <button
                  onClick={() => setSelectedSource('marketplace')}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium transition-colors',
                    selectedSource === 'marketplace'
                      ? 'bg-black/10 text-foreground dark:bg-white/10'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t('filter.marketplace', { count: sourceStats.marketplace })}
                </button>
              </div>
            </div>
          </div>
          {error && (
            <div className="mb-4 p-4 rounded-xl border border-destructive/50 bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>
                {[
                  'fetchTimeoutError',
                  'fetchRateLimitError',
                  'timeoutError',
                  'rateLimitError',
                ].includes(error)
                  ? t(`toast.${error}`, { path: skillsDirPath })
                  : error}
              </span>
            </div>
          )}

          <div className="pr-1 pb-8">
            {filteredSkills.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-black/10 bg-white/60 py-20 text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
                <Puzzle className="mb-4 h-10 w-10 opacity-50" />
                <p>{searchQuery ? t('noSkillsSearch') : t('noSkillsAvailable')}</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-[20px] border border-black/7 bg-white/55 dark:border-white/8 dark:bg-white/[0.02]">
                {filteredSkills.map((skill, index) => (
                  <div
                    key={skill.id}
                    className={cn(
                      'group flex cursor-pointer flex-row items-center justify-between px-4 py-3 transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.03]',
                      index !== filteredSkills.length - 1 &&
                        'border-b border-black/6 dark:border-white/6'
                    )}
                    onClick={() => setSelectedSkill(skill)}
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-4 pr-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-black/7 bg-background/90 text-2xl dark:border-white/10 dark:bg-background/60">
                        {skill.icon || '🧩'}
                      </div>
                      <div className="min-w-0 flex flex-col">
                        <div className="mb-1 flex items-center gap-2">
                          <h3 className="truncate text-[15px] font-semibold text-foreground">
                            {skill.name}
                          </h3>
                          {skill.isCore ? (
                            <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                          ) : skill.isBundled ? (
                            <Puzzle className="h-3 w-3 shrink-0 text-blue-500/70" />
                          ) : null}
                        </div>
                        <p className="line-clamp-1 text-[13px] leading-relaxed text-muted-foreground">
                          {skill.description}
                        </p>
                        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-foreground/55">
                          <Badge
                            variant="secondary"
                            className="h-5 shrink-0 rounded-full border border-black/5 bg-black/5 px-2 py-0 text-[10px] font-medium shadow-none dark:border-white/8 dark:bg-white/10"
                          >
                            {resolveSkillSourceLabel(skill, t)}
                          </Badge>
                          {skill.version && (
                            <span className="shrink-0 font-mono text-muted-foreground">
                              v{skill.version}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div
                      className="flex shrink-0 items-center gap-4"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Switch
                        checked={skill.enabled}
                        onCheckedChange={(checked) => handleToggle(skill.id, checked)}
                        disabled={skill.isCore}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <Sheet open={installSheetOpen} onOpenChange={setInstallSheetOpen}>
        <SheetContent
          className="flex w-full flex-col border-l border-black/10 bg-card p-0 shadow-[0_0_40px_rgba(0,0,0,0.2)] dark:border-white/10 dark:bg-card sm:max-w-[560px]"
          side="right"
        >
          <div className="border-b border-black/10 bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent)] px-7 py-6 dark:border-white/10 dark:bg-[linear-gradient(180deg,rgba(16,185,129,0.10),transparent)]">
            <h2 className="text-[24px] font-heading text-foreground font-normal tracking-tight">
              {t('marketplace.installDialogTitle')}
            </h2>
            <p className="mt-1 text-[13px] text-foreground/70">
              {t('marketplace.installDialogSubtitle')}
            </p>
            <div className="mt-4 flex flex-col md:flex-row gap-2">
              <div className="relative flex items-center bg-black/5 dark:bg-white/5 rounded-xl px-3 py-2 border border-black/10 dark:border-white/10 flex-1">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  placeholder={t('searchMarketplace')}
                  value={installQuery}
                  onChange={(e) => setInstallQuery(e.target.value)}
                  className="ml-2 h-auto border-0 bg-transparent p-0 shadow-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 text-[13px]"
                />
                {installQuery && (
                  <button
                    type="button"
                    onClick={() => setInstallQuery('')}
                    className="text-foreground/50 hover:text-foreground shrink-0 ml-1"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <Button
                variant={marketplaceSource === 'clawhub' ? 'secondary' : 'outline'}
                onClick={() => setMarketplaceSource('clawhub')}
                className="h-10 rounded-xl border-black/10 dark:border-white/10 bg-transparent text-[12px]"
              >
                {t('marketplace.sourceClawHub')}
              </Button>
              <Button
                variant={marketplaceSource === 'tencent' ? 'secondary' : 'outline'}
                onClick={() => setMarketplaceSource('tencent')}
                className="h-10 rounded-xl border-black/10 dark:border-white/10 bg-transparent text-[12px]"
              >
                {t('marketplace.sourceTencent')}
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {searchError && (
              <div className="mb-4 p-4 rounded-xl border border-destructive/50 bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
                <AlertCircle className="h-5 w-5 shrink-0" />
                <span>
                  {[
                    'searchTimeoutError',
                    'searchRateLimitError',
                    'timeoutError',
                    'rateLimitError',
                  ].includes(searchError.replace('Error: ', ''))
                    ? t(`toast.${searchError.replace('Error: ', '')}`, { path: skillsDirPath })
                    : t('marketplace.searchError')}
                </span>
              </div>
            )}

            {searching && (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <LoadingSpinner size="lg" />
                <p className="mt-4 text-sm">{t('marketplace.searching')}</p>
              </div>
            )}

            {!searching && searchResults.length > 0 && (
              <div className="flex flex-col gap-3">
                {searchResults.map((skill) => {
                  const isInstalled = safeSkills.some(
                    (s) => s.id === skill.slug || s.name === skill.name
                  );
                  const isInstallLoading = !!installing[skill.slug];

                  return (
                    <div
                      key={skill.slug}
                      className="group flex cursor-pointer flex-row items-center justify-between rounded-xl border border-black/7 bg-white/65 px-4 py-4 transition-colors hover:bg-white dark:border-white/8 dark:bg-white/[0.03] dark:hover:bg-white/[0.05]"
                      onClick={() =>
                        invokeIpc(
                          'shell:openExternal',
                          marketplaceSource === 'tencent'
                            ? `https://clawhub.tencent.com/s/${skill.slug}`
                            : `https://clawhub.ai/s/${skill.slug}`
                        )
                      }
                    >
                      <div className="flex items-start gap-4 flex-1 overflow-hidden pr-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-black/7 bg-background/90 text-xl dark:border-white/10 dark:bg-background/60">
                          📦
                        </div>
                        <div className="flex flex-col overflow-hidden">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="text-[15px] font-semibold text-foreground truncate">
                              {skill.name}
                            </h3>
                            {skill.author && (
                              <span className="text-xs text-muted-foreground">
                                • {skill.author}
                              </span>
                            )}
                          </div>
                          <p className="text-[13.5px] text-muted-foreground line-clamp-1 pr-6 leading-relaxed">
                            {skill.description}
                          </p>
                        </div>
                      </div>
                      <div
                        className="flex items-center gap-4 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {skill.version && (
                          <span className="text-[13px] font-mono text-muted-foreground mr-2">
                            v{skill.version}
                          </span>
                        )}
                        {isInstalled ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleUninstall(skill.slug)}
                            disabled={isInstallLoading}
                            className="h-8 shadow-none"
                          >
                            {isInstallLoading ? (
                              <LoadingSpinner size="sm" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        ) : (
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => handleInstall(skill.slug)}
                            disabled={isInstallLoading}
                            className="h-8 px-4 rounded-full shadow-none font-medium text-xs"
                          >
                            {isInstallLoading ? (
                              <LoadingSpinner size="sm" />
                            ) : (
                              t('marketplace.install', 'Install')
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!searching && searchResults.length === 0 && !searchError && (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-black/10 bg-white/60 py-20 text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
                <Package className="mb-4 h-10 w-10 opacity-50" />
                <p>
                  {installQuery.trim() ? t('marketplace.noResults') : t('marketplace.emptyPrompt')}
                </p>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Skill Detail Dialog */}
      <SkillDetailDialog
        skill={selectedSkill}
        isOpen={!!selectedSkill}
        onClose={() => setSelectedSkill(null)}
        onToggle={(enabled) => {
          if (!selectedSkill) return;
          handleToggle(selectedSkill.id, enabled);
          setSelectedSkill({ ...selectedSkill, enabled });
        }}
        onUninstall={handleUninstall}
        onOpenFolder={handleOpenSkillFolder}
      />
    </div>
  );
}

export default Skills;
