/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC — only lightweight path references
 * are sent with the message (no base64 over WebSocket).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  SendHorizontal,
  Circle,
  X,
  Paperclip,
  FileText,
  Film,
  Music,
  FileArchive,
  File,
  Loader2,
  ChevronDown,
  Check,
  Slash,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useProviderStore } from '@/stores/providers';
import { useSkillsStore } from '@/stores/skills';
import { buildProviderListItems } from '@/lib/provider-accounts';
import { useTranslation } from 'react-i18next';

// ── Types ────────────────────────────────────────────────────────

export interface FileAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string; // disk path for gateway
  preview: string | null; // data URL for images, null for others
  status: 'staging' | 'ready' | 'error';
  error?: string;
}

interface ChatInputProps {
  onSend: (text: string, attachments?: FileAttachment[], targetAgentId?: string | null) => void;
  onStop?: () => void;
  disabled?: boolean;
  sending?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  )
    return <FileText className={className} />;
  if (
    mimeType.includes('zip') ||
    mimeType.includes('compressed') ||
    mimeType.includes('archive') ||
    mimeType.includes('tar') ||
    mimeType.includes('rar') ||
    mimeType.includes('7z')
  )
    return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

/**
 * Read a browser File object as base64 string (without the data URL prefix).
 */
function readFileAsBase64(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (!dataUrl || !dataUrl.includes(',')) {
        reject(new Error(`Invalid data URL from FileReader for ${file.name}`));
        return;
      }
      const base64 = dataUrl.split(',')[1];
      if (!base64) {
        reject(new Error(`Empty base64 data for ${file.name}`));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// ── Component ────────────────────────────────────────────────────

export function ChatInput({ onSend, onStop, disabled = false, sending = false }: ChatInputProps) {
  const { t } = useTranslation(['chat', 'agents']);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const accounts = useProviderStore((s) => s.accounts);
  const statuses = useProviderStore((s) => s.statuses);
  const vendors = useProviderStore((s) => s.vendors);
  const defaultAccountId = useProviderStore((s) => s.defaultAccountId);
  const refreshProviderSnapshot = useProviderStore((s) => s.refreshProviderSnapshot);
  const setDefaultAccount = useProviderStore((s) => s.setDefaultAccount);
  const skills = useSkillsStore((s) => s.skills);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const providerItems = useMemo(
    () => buildProviderListItems(accounts, statuses, vendors, defaultAccountId),
    [accounts, statuses, vendors, defaultAccountId]
  );
  const defaultModelAbbr = useMemo(() => {
    const item = providerItems.find((p) => p.account.id === defaultAccountId);
    return (item?.account.model || item?.account.vendorId || '??').slice(0, 5).toUpperCase();
  }, [providerItems, defaultAccountId]);
  const currentAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.id === currentAgentId) ?? null,
    [agents, currentAgentId]
  );
  const currentAgentFixedModelAbbr = useMemo(() => {
    if (!currentAgent || currentAgent.inheritedModel) return null;
    return (currentAgent.modelDisplay || '??').slice(0, 5).toUpperCase();
  }, [currentAgent]);
  const modelChipAbbr = currentAgentFixedModelAbbr || defaultModelAbbr;
  const canSwitchModel = !currentAgent || currentAgent.inheritedModel;
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

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  // Focus textarea on mount (avoids Windows focus loss after session delete + native dialog)
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  useEffect(() => {
    void refreshProviderSnapshot();
  }, [refreshProviderSnapshot]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [modelPickerOpen]);

  useEffect(() => {
    if (!canSwitchModel && modelPickerOpen) {
      setModelPickerOpen(false);
    }
  }, [canSwitchModel, modelPickerOpen]);

  useEffect(() => {
    if (!skillPickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!skillPickerRef.current?.contains(event.target as Node)) {
        setSkillPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [skillPickerOpen]);

  // ── File staging via native dialog ─────────────────────────────

  const pickFiles = useCallback(async () => {
    try {
      const result = (await invokeIpc('dialog:open', {
        properties: ['openFile', 'multiSelections'],
      })) as { canceled: boolean; filePaths?: string[] };
      if (result.canceled || !result.filePaths?.length) return;

      // Add placeholder entries immediately
      const tempIds: string[] = [];
      for (const filePath of result.filePaths) {
        const tempId = crypto.randomUUID();
        tempIds.push(tempId);
        // Handle both Unix (/) and Windows (\) path separators
        const fileName = filePath.split(/[\\/]/).pop() || 'file';
        setAttachments((prev) => [
          ...prev,
          {
            id: tempId,
            fileName,
            mimeType: '',
            fileSize: 0,
            stagedPath: '',
            preview: null,
            status: 'staging' as const,
          },
        ]);
      }

      // Stage all files via IPC
      console.log('[pickFiles] Staging files:', result.filePaths);
      const staged = await hostApiFetch<
        Array<{
          id: string;
          fileName: string;
          mimeType: string;
          fileSize: number;
          stagedPath: string;
          preview: string | null;
        }>
      >('/api/files/stage-paths', {
        method: 'POST',
        body: JSON.stringify({ filePaths: result.filePaths }),
      });
      console.log(
        '[pickFiles] Stage result:',
        staged?.map((s) => ({
          id: s?.id,
          fileName: s?.fileName,
          mimeType: s?.mimeType,
          fileSize: s?.fileSize,
          stagedPath: s?.stagedPath,
          hasPreview: !!s?.preview,
        }))
      );

      // Update each placeholder with real data
      setAttachments((prev) => {
        let updated = [...prev];
        for (let i = 0; i < tempIds.length; i++) {
          const tempId = tempIds[i];
          const data = staged[i];
          if (data) {
            updated = updated.map((a) =>
              a.id === tempId ? { ...data, status: 'ready' as const } : a
            );
          } else {
            console.warn(`[pickFiles] No staged data for tempId=${tempId} at index ${i}`);
            updated = updated.map((a) =>
              a.id === tempId ? { ...a, status: 'error' as const, error: 'Staging failed' } : a
            );
          }
        }
        return updated;
      });
    } catch (err) {
      console.error('[pickFiles] Failed to stage files:', err);
      // Mark any stuck 'staging' attachments as 'error' so the user can remove them
      // and the send button isn't permanently blocked
      setAttachments((prev) =>
        prev.map((a) =>
          a.status === 'staging' ? { ...a, status: 'error' as const, error: String(err) } : a
        )
      );
    }
  }, []);

  // ── Stage browser File objects (paste / drag-drop) ─────────────

  const stageBufferFiles = useCallback(async (files: globalThis.File[]) => {
    for (const file of files) {
      const tempId = crypto.randomUUID();
      setAttachments((prev) => [
        ...prev,
        {
          id: tempId,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          fileSize: file.size,
          stagedPath: '',
          preview: null,
          status: 'staging' as const,
        },
      ]);

      try {
        console.log(`[stageBuffer] Reading file: ${file.name} (${file.type}, ${file.size} bytes)`);
        const base64 = await readFileAsBase64(file);
        console.log(`[stageBuffer] Base64 length: ${base64?.length ?? 'null'}`);
        const staged = await hostApiFetch<{
          id: string;
          fileName: string;
          mimeType: string;
          fileSize: number;
          stagedPath: string;
          preview: string | null;
        }>('/api/files/stage-buffer', {
          method: 'POST',
          body: JSON.stringify({
            base64,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
          }),
        });
        console.log(
          `[stageBuffer] Staged: id=${staged?.id}, path=${staged?.stagedPath}, size=${staged?.fileSize}`
        );
        setAttachments((prev) =>
          prev.map((a) => (a.id === tempId ? { ...staged, status: 'ready' as const } : a))
        );
      } catch (err) {
        console.error(`[stageBuffer] Error staging ${file.name}:`, err);
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === tempId ? { ...a, status: 'error' as const, error: String(err) } : a
          )
        );
      }
    }
  }, []);

  // ── Attachment management ──────────────────────────────────────

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const allReady = attachments.length === 0 || attachments.every((a) => a.status === 'ready');
  const hasFailedAttachments = attachments.some((a) => a.status === 'error');
  const canSend = (input.trim() || attachments.length > 0) && allReady && !disabled && !sending;
  const canStop = sending && !disabled && !!onStop;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const readyAttachments = attachments.filter((a) => a.status === 'ready');
    // Capture values before clearing — clear input immediately for snappy UX,
    // but keep attachments available for the async send
    let textToSend = input.trim();
    if (selectedSkill) {
      const skillDirective = t('composer.skillDirective', {
        skillName: selectedSkill.name,
        skillId: selectedSkill.id,
      });
      textToSend = textToSend ? `${skillDirective}\n\n${textToSend}` : skillDirective;
    }
    const attachmentsToSend = readyAttachments.length > 0 ? readyAttachments : undefined;
    console.log(
      `[handleSend] text="${textToSend.substring(0, 50)}", attachments=${attachments.length}, ready=${readyAttachments.length}, sending=${!!attachmentsToSend}`
    );
    if (attachmentsToSend) {
      console.log(
        '[handleSend] Attachment details:',
        attachmentsToSend.map((a) => ({
          id: a.id,
          fileName: a.fileName,
          mimeType: a.mimeType,
          fileSize: a.fileSize,
          stagedPath: a.stagedPath,
          status: a.status,
          hasPreview: !!a.preview,
        }))
      );
    }
    setInput('');
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    onSend(textToSend, attachmentsToSend, null);
    setSelectedSkillId(null);
    setSkillPickerOpen(false);
  }, [input, attachments, canSend, onSend, selectedSkill, t]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    onStop?.();
  }, [canStop, onStop]);

  const handleSwitchModel = useCallback(
    async (accountId: string) => {
      if (!accountId || accountId === defaultAccountId) {
        setModelPickerOpen(false);
        return;
      }
      if (!canSwitchModel) {
        setModelPickerOpen(false);
        return;
      }
      try {
        await setDefaultAccount(accountId);
        await fetchAgents();
        setModelPickerOpen(false);
      } catch (error) {
        console.error('Failed to switch default model:', error);
      }
    },
    [canSwitchModel, defaultAccountId, fetchAgents, setDefaultAccount]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const nativeEvent = e.nativeEvent as KeyboardEvent;
        if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
          return;
        }
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Handle paste (Ctrl/Cmd+V with files)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const pastedFiles: globalThis.File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        stageBufferFiles(pastedFiles);
      }
    },
    [stageBufferFiles]
  );

  // Handle drag & drop
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) {
        stageBufferFiles(Array.from(e.dataTransfer.files));
      }
    },
    [stageBufferFiles]
  );

  return (
    <div
      className={cn('p-4 pb-2 w-full mx-auto transition-all duration-300', 'max-w-4xl')}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="w-full">
        {/* Attachment Previews */}
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-3 flex-wrap">
            {attachments.map((att) => (
              <AttachmentPreview
                key={att.id}
                attachment={att}
                onRemove={() => removeAttachment(att.id)}
              />
            ))}
          </div>
        )}

        {/* Input Row */}
        <div
          className={`relative bg-white dark:bg-card rounded-[8px] shadow-sm border p-1.5 transition-all ${dragOver ? 'border-primary ring-1 ring-primary' : 'border-black/10 dark:border-white/10'}`}
        >
          {selectedSkill && (
            <div className="flex flex-wrap gap-2 px-2.5 pt-2 pb-1">
              <button
                type="button"
                onClick={() => setSelectedSkillId(null)}
                className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-black/5 px-2.5 py-0.5 text-[12px] font-medium text-foreground transition-colors hover:bg-black/10 dark:border-white/10 dark:bg-white/10 dark:hover:bg-white/15"
                title={t('composer.clearSkill')}
              >
                <span>{t('composer.skillChip', { skill: selectedSkill.name })}</span>
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            {/* Textarea */}
            <div className="relative">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onPaste={handlePaste}
                placeholder={disabled ? t('composer.gatewayDisconnectedPlaceholder') : ''}
                disabled={disabled}
                className="min-h-[80px] max-h-[120px] resize-none overflow-y-auto border-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none bg-transparent py-2.5 px-2 text-base placeholder:text-muted-foreground/60 leading-relaxed [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                rows={2}
              />
            </div>

            {/* Button Row */}
            <div className="flex items-center gap-1.5">
              <div ref={modelPickerRef} className="relative shrink-0">
                <Button
                  variant="ghost"
                  className={cn(
                    'h-7 gap-1 rounded-[8px] border border-black/8 bg-transparent px-2 text-foreground/80 transition-colors hover:bg-black/[0.05] hover:text-foreground dark:border-white/10 dark:hover:bg-white/[0.08]',
                    modelPickerOpen && 'bg-primary/10 text-primary hover:bg-primary/20'
                  )}
                  onClick={() => setModelPickerOpen((open) => !open)}
                  disabled={disabled || sending || providerItems.length === 0 || !canSwitchModel}
                  title={t('composer.pickModel')}
                >
                  <span className="max-w-[4.25rem] truncate font-mono text-[10px] font-medium uppercase leading-none">
                    {modelChipAbbr}
                  </span>
                  <ChevronDown
                    className={cn(
                      'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                      modelPickerOpen && 'rotate-180'
                    )}
                  />
                </Button>
                {modelPickerOpen && canSwitchModel && (
                  <div className="absolute left-0 bottom-full z-20 mb-2 w-80 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card">
                    <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground/80">
                      {t('composer.modelPickerTitle')}
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                      {providerItems.map((item) => {
                        const isSelected = item.account.id === defaultAccountId;
                        return (
                          <button
                            key={item.account.id}
                            type="button"
                            onClick={() => void handleSwitchModel(item.account.id)}
                            className={cn(
                              'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors',
                              isSelected
                                ? 'bg-primary/10 text-foreground'
                                : 'hover:bg-black/5 dark:hover:bg-white/5'
                            )}
                          >
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/5 dark:bg-white/5">
                              <span className="text-[10px] font-bold uppercase text-foreground/70">
                                {(item.account.model || item.account.vendorId || '??').slice(0, 2)}
                              </span>
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] font-medium text-foreground">
                                {item.account.model || item.account.label}
                              </div>
                              <div className="truncate text-[11px] text-muted-foreground">
                                {item.vendor?.name || item.account.vendorId}
                                {item.account.model ? ` · ${item.account.label}` : ''}
                              </div>
                            </div>
                            {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Attach Button */}
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-7 w-7 rounded-[8px] border border-black/8 bg-transparent text-muted-foreground hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10 hover:text-foreground transition-colors"
                onClick={pickFiles}
                disabled={disabled || sending}
                title={t('composer.attachFiles')}
              >
                <Paperclip className="h-4 w-4" />
              </Button>

              <div ref={skillPickerRef} className="relative shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-7 w-7 rounded-[8px] border border-black/8 bg-transparent text-muted-foreground hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10 hover:text-foreground transition-colors',
                    (skillPickerOpen || selectedSkill) &&
                      'bg-primary/10 text-primary hover:bg-primary/20'
                  )}
                  onClick={() => {
                    if (selectableSkills.length === 0) {
                      void fetchSkills();
                    }
                    setSkillPickerOpen((open) => !open);
                  }}
                  disabled={disabled || sending}
                  title={t('composer.pickSkill')}
                >
                  <Slash className="h-3.5 w-3.5" />
                </Button>
                {skillPickerOpen && (
                  <div className="absolute left-0 bottom-full z-20 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card">
                    <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground/80">
                      {t('composer.skillPickerTitle')}
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {selectableSkills.length > 0 ? (
                        selectableSkills.map((skill) => (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => {
                              setSelectedSkillId(skill.id);
                              setSkillPickerOpen(false);
                              textareaRef.current?.focus();
                            }}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors',
                              selectedSkillId === skill.id
                                ? 'bg-primary/10 text-foreground'
                                : 'hover:bg-black/5 dark:hover:bg-white/5'
                            )}
                          >
                            <span className="text-[13px] leading-none">{skill.icon || '🔧'}</span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] font-medium text-foreground">
                                {skill.name}
                              </div>
                              <div className="truncate text-[11px] text-muted-foreground">
                                {skill.id}
                              </div>
                            </div>
                            {selectedSkillId === skill.id && (
                              <Check className="h-4 w-4 shrink-0 text-primary" />
                            )}
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-2 text-[12px] text-muted-foreground">
                          {t('composer.noSkillsAvailable')}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Spacer to push send button to the right */}
              <div className="flex-1" />

              {/* Send Button */}
              <Button
                onClick={sending ? handleStop : handleSend}
                disabled={sending ? !canStop : !canSend}
                size="icon"
                className={`shrink-0 h-7 w-7 rounded-[8px] border border-black/8 dark:border-white/10 transition-colors ${
                  sending || canSend
                    ? 'bg-black/5 dark:bg-white/10 text-foreground hover:bg-black/10 dark:hover:bg-white/20'
                    : 'text-muted-foreground/50 hover:bg-transparent bg-transparent'
                }`}
                variant="ghost"
                title={sending ? t('composer.stop') : t('composer.send')}
              >
                {sending ? (
                  <Circle className="h-4 w-4" fill="currentColor" />
                ) : (
                  <SendHorizontal className="h-[18px] w-[18px]" strokeWidth={2} />
                )}
              </Button>
            </div>
          </div>
        </div>
        <div className="mt-2.5 flex items-center justify-end gap-2 text-[11px] text-muted-foreground/60 px-4">
          {hasFailedAttachments && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-[11px]"
              onClick={() => {
                setAttachments((prev) => prev.filter((att) => att.status !== 'error'));
                void pickFiles();
              }}
            >
              {t('composer.retryFailedAttachments')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Attachment Preview ───────────────────────────────────────────

function AttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: FileAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.mimeType.startsWith('image/') && attachment.preview;

  return (
    <div className="relative group rounded-lg overflow-hidden border border-border">
      {isImage ? (
        // Image thumbnail
        <div className="w-16 h-16">
          <img
            src={attachment.preview!}
            alt={attachment.fileName}
            className="w-full h-full object-cover"
          />
        </div>
      ) : (
        // Generic file card
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 max-w-[200px]">
          <FileIcon
            mimeType={attachment.mimeType}
            className="h-5 w-5 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 overflow-hidden">
            <p className="text-xs font-medium truncate">{attachment.fileName}</p>
            <p className="text-[10px] text-muted-foreground">
              {attachment.fileSize > 0 ? formatFileSize(attachment.fileSize) : '...'}
            </p>
          </div>
        </div>
      )}

      {/* Staging overlay */}
      {attachment.status === 'staging' && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
          <Loader2 className="h-4 w-4 text-white animate-spin" />
        </div>
      )}

      {/* Error overlay */}
      {attachment.status === 'error' && (
        <div className="absolute inset-0 bg-destructive/20 flex items-center justify-center">
          <span className="text-[10px] text-destructive font-medium px-1">Error</span>
        </div>
      )}

      {/* Remove button */}
      <button
        onClick={onRemove}
        className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
