import { useCallback, useEffect, useMemo, useState } from 'react';
import { Mail, Send, Inbox, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { hostApiFetch } from '@/lib/host-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

type MailAccount = {
  id: string;
  label: string;
  email: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  createdAt: string;
  updatedAt: string;
  hasPassword: boolean;
};

type MailItem = {
  uid: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  size: number;
  seen: boolean;
};

type MailDetail = MailItem & {
  bodyText: string;
};

type AccountForm = {
  id?: string;
  label: string;
  email: string;
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
};

const defaultForm: AccountForm = {
  label: '',
  email: '',
  username: '',
  password: '',
  imapHost: 'imap.qq.com',
  imapPort: 993,
  imapTls: true,
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
  smtpTls: true,
};

export function MailPage() {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [savingAccount, setSavingAccount] = useState(false);
  const [form, setForm] = useState<AccountForm>({ ...defaultForm });
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'inbox' | 'compose'>('inbox');

  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [pulling, setPulling] = useState(false);
  const [sending, setSending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [messages, setMessages] = useState<MailItem[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<MailItem | null>(null);
  const [selectedMessageDetail, setSelectedMessageDetail] = useState<MailDetail | null>(null);
  const [loadingMessageDetail, setLoadingMessageDetail] = useState(false);

  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');

  const activeAccount = useMemo(
    () => accounts.find((item) => item.id === selectedAccountId) || null,
    [accounts, selectedAccountId],
  );

  const fetchAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const result = await hostApiFetch<{ success: boolean; accounts?: MailAccount[]; error?: string }>(
        '/api/mail/accounts',
      );
      if (!result.success) {
        throw new Error(result.error || '加载邮箱账号失败');
      }
      const nextAccounts = result.accounts || [];
      setAccounts(nextAccounts);
      setSelectedAccountId((currentId) => {
        if (!currentId && nextAccounts[0]) return nextAccounts[0].id;
        if (currentId && !nextAccounts.some((item) => item.id === currentId)) {
          return nextAccounts[0]?.id || '';
        }
        return currentId;
      });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    void fetchAccounts();
  }, [fetchAccounts]);

  const handleSaveAccount = async () => {
    setSavingAccount(true);
    try {
      const result = await hostApiFetch<{ success: boolean; account?: MailAccount; error?: string }>(
        '/api/mail/accounts',
        {
          method: 'POST',
          body: JSON.stringify(form),
        },
      );
      if (!result.success || !result.account) {
        throw new Error(result.error || '保存邮箱账号失败');
      }
      toast.success('邮箱账号已保存');
      setForm((prev) => ({ ...prev, id: result.account?.id, password: '' }));
      await fetchAccounts();
      setSelectedAccountId(result.account.id);
      setAccountModalOpen(false);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingAccount(false);
    }
  };

  const handleSelectAccount = (account: MailAccount) => {
    setSelectedAccountId(account.id);
    setForm({
      id: account.id,
      label: account.label,
      email: account.email,
      username: account.username,
      password: '',
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapTls: account.imapTls,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpTls: account.smtpTls,
    });
  };

  const handleDeleteAccount = async (accountId: string) => {
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>(
        `/api/mail/accounts/${encodeURIComponent(accountId)}`,
        { method: 'DELETE' },
      );
      if (!result.success) {
        throw new Error(result.error || '删除邮箱账号失败');
      }
      toast.success('邮箱账号已删除');
      if (form.id === accountId) {
        setForm({ ...defaultForm });
      }
      await fetchAccounts();
      setAccountModalOpen(false);
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handlePullUnread = async () => {
    if (!selectedAccountId) {
      toast.error('请先选择邮箱账号');
      return;
    }
    setPulling(true);
    try {
      const result = await hostApiFetch<{ success: boolean; messages?: MailItem[]; error?: string }>(
        '/api/mail/receive',
        {
          method: 'POST',
          body: JSON.stringify({ accountId: selectedAccountId, limit: 20 }),
        },
      );
      if (!result.success) {
        throw new Error(result.error || '收取邮件失败');
      }
      setMessages(result.messages || []);
      toast.success(`收取完成，共 ${(result.messages || []).length} 封未读邮件`);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setPulling(false);
    }
  };

  const loadStoredMessages = useCallback(async (accountId: string) => {
    if (!accountId) {
      setMessages([]);
      return;
    }
    try {
      const result = await hostApiFetch<{ success: boolean; messages?: MailItem[]; error?: string }>(
        `/api/mail/messages?accountId=${encodeURIComponent(accountId)}&limit=50`,
      );
      if (!result.success) {
        throw new Error(result.error || '加载本地邮件缓存失败');
      }
      setMessages(result.messages || []);
    } catch (error) {
      toast.error(String(error));
    }
  }, []);

  const handleSendMail = async () => {
    if (!selectedAccountId) {
      toast.error('请先选择邮箱账号');
      return;
    }
    if (!to.trim()) {
      toast.error('请填写收件人');
      return;
    }
    setSending(true);
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/mail/send', {
        method: 'POST',
        body: JSON.stringify({
          accountId: selectedAccountId,
          to,
          cc,
          bcc,
          subject,
          content,
        }),
      });
      if (!result.success) {
        throw new Error(result.error || '发送邮件失败');
      }
      toast.success('邮件发送成功');
      setTo('');
      setCc('');
      setBcc('');
      setSubject('');
      setContent('');
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!selectedAccountId) {
      setMessages([]);
      return;
    }
    void loadStoredMessages(selectedAccountId);
  }, [loadStoredMessages, selectedAccountId]);

  const openCreateAccountModal = () => {
    setForm({ ...defaultForm });
    setAccountModalOpen(true);
  };

  const openEditCurrentAccountModal = () => {
    if (!activeAccount) {
      openCreateAccountModal();
      return;
    }
    handleSelectAccount(activeAccount);
    setAccountModalOpen(true);
  };

  const switchToNextAccount = () => {
    if (accounts.length <= 1) return;
    const currentIndex = accounts.findIndex((item) => item.id === selectedAccountId);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % accounts.length;
    setSelectedAccountId(accounts[nextIndex].id);
  };

  const extractReplyAddress = (rawFrom: string): string => {
    const text = rawFrom.trim();
    if (!text) return '';
    const angleMatch = text.match(/<([^>]+)>/);
    if (angleMatch?.[1]) {
      return angleMatch[1].trim();
    }
    return text;
  };

  const handleQuickReply = (item: MailItem) => {
    const replyTo = extractReplyAddress(item.from);
    if (!replyTo) {
      toast.error('无法识别发件人地址');
      return;
    }
    const nextSubject = item.subject.trim().toLowerCase().startsWith('re:')
      ? item.subject
      : `Re: ${item.subject || ''}`.trim();
    setTo(replyTo);
    setCc('');
    setBcc('');
    setSubject(nextSubject);
    setContent(`\n\n--- 原邮件 ---\n发件人: ${item.from}\n时间: ${item.date}\n主题: ${item.subject}\n`);
    setActiveTab('compose');
    setSelectedMessage(null);
  };

  const sanitizeHtml = (html: string): string => {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      doc.querySelectorAll('script, iframe, object, embed, link[rel="import"]').forEach((node) => {
        node.remove();
      });
      doc.querySelectorAll('*').forEach((el) => {
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          const value = attr.value.toLowerCase();
          if (name.startsWith('on')) {
            el.removeAttribute(attr.name);
            continue;
          }
          if ((name === 'href' || name === 'src') && value.startsWith('javascript:')) {
            el.removeAttribute(attr.name);
          }
        }
      });
      return doc.body?.innerHTML || doc.documentElement.innerHTML;
    } catch {
      return html;
    }
  };

  const bodyRender = useMemo(() => {
    const body = selectedMessageDetail?.bodyText || '';
    const trimmed = body.trim();
    const maybeHtml = /<([a-z][\w-]*)(\s[^>]*)?>/i.test(trimmed);
    if (!trimmed) {
      return { kind: 'empty' as const, value: '' };
    }
    if (maybeHtml) {
      const matchedHtml = trimmed.match(/<html[\s\S]*<\/html>/i)?.[0]
        || trimmed.match(/<body[\s\S]*<\/body>/i)?.[0]
        || trimmed;
      const safeHtml = sanitizeHtml(matchedHtml);
      const srcDoc = `<!doctype html><html><head><meta charset="utf-8"/><style>html,body{margin:0;padding:0;background:#fff;color:#111}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",PingFang SC,Microsoft YaHei,sans-serif;padding:12px;line-height:1.65;font-size:13px;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap;word-break:break-word}blockquote{margin:0;padding-left:12px;border-left:3px solid rgba(0,0,0,.12);color:#555}a{color:#0f766e;text-decoration:none}</style></head><body>${safeHtml}</body></html>`;
      return { kind: 'html' as const, value: srcDoc };
    }
    return { kind: 'text' as const, value: body };
  }, [selectedMessageDetail]);

  const handleExportToWorkspace = async () => {
    if (!selectedAccountId) {
      toast.error('请先选择邮箱账号');
      return;
    }
    setExporting(true);
    try {
      const result = await hostApiFetch<{
        success: boolean;
        dir?: string;
        indexFile?: string;
        exportedCount?: number;
        error?: string;
      }>('/api/mail/export', {
        method: 'POST',
        body: JSON.stringify({
          accountId: selectedAccountId,
          limit: 100,
        }),
      });
      if (!result.success) {
        throw new Error(result.error || '导出失败');
      }
      toast.success(`已导出 ${result.exportedCount || 0} 封邮件到本地: ${result.indexFile || result.dir}`);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setExporting(false);
    }
  };

  const openMessageDetail = async (item: MailItem) => {
    setSelectedMessage(item);
    setLoadingMessageDetail(true);
    setSelectedMessageDetail(null);
    try {
      if (!selectedAccountId) {
        throw new Error('请先选择邮箱账号');
      }
      const result = await hostApiFetch<{ success: boolean; detail?: MailDetail; error?: string }>(
        '/api/mail/detail',
        {
          method: 'POST',
          body: JSON.stringify({
            accountId: selectedAccountId,
            uid: item.uid,
            useCache: true,
          }),
        },
      );
      if (!result.success || !result.detail) {
        throw new Error(result.error || '加载邮件详情失败');
      }
      setSelectedMessageDetail(result.detail);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoadingMessageDetail(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[980px] space-y-4 pb-6">
      <div className="rounded-xl border border-black/10 bg-white/75 p-4 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-[24px] font-semibold text-foreground">邮件助手</h1>
            <p className="mt-1 text-[12px] text-muted-foreground">
              当前版本推荐 IMAP(993)+SMTP(465)。
            </p>
            <p className="mt-2 text-[12px] text-foreground/75">
              当前账号：{activeAccount ? `${activeAccount.label} (${activeAccount.email})` : '未选择'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={switchToNextAccount}
              disabled={accounts.length <= 1}
            >
              切换账号
            </Button>
            <Button type="button" size="sm" onClick={openCreateAccountModal}>
              新建账号
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={openEditCurrentAccountModal}>
              账号设置
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => void fetchAccounts()}
              disabled={loadingAccounts}
            >
              <RefreshCw className={cn('h-4 w-4', loadingAccounts && 'animate-spin')} />
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-black/10 bg-white/80 p-3 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('inbox')}
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded-md px-3 text-[12px] font-medium transition-colors',
              activeTab === 'inbox'
                ? 'bg-black/10 text-foreground dark:bg-white/10'
                : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <Inbox className="h-3.5 w-3.5" />
            收件
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('compose')}
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded-md px-3 text-[12px] font-medium transition-colors',
              activeTab === 'compose'
                ? 'bg-black/10 text-foreground dark:bg-white/10'
                : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <Send className="h-3.5 w-3.5" />
            发信
          </button>
        </div>
      </div>

      {activeTab === 'inbox' ? (
        <section className="space-y-3 rounded-xl border border-black/10 bg-white/80 p-4 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
              <Inbox className="h-4 w-4" />
              代收邮件
            </h2>
            <Button
              type="button"
              size="sm"
              onClick={() => void handlePullUnread()}
              disabled={pulling || !activeAccount}
            >
              {pulling ? '收取中...' : '收取未读'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleExportToWorkspace()}
              disabled={exporting || !activeAccount}
            >
              {exporting ? '导出中...' : '导出到对话文件'}
            </Button>
          </div>

          <div className="max-h-[360px] space-y-2 overflow-auto pr-1">
            {messages.length === 0 ? (
              <div className="rounded-lg border border-dashed border-black/10 p-3 text-[12px] text-muted-foreground dark:border-white/10">
                暂无邮件，点击“收取未读”开始同步。
              </div>
            ) : (
              messages.map((item) => (
                <div key={item.uid} className="rounded-lg border border-black/10 p-3 dark:border-white/10">
                  <div className="text-[13px] font-semibold text-foreground">{item.subject}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">发件人：{item.from || '未知'}</div>
                  <div className="text-[11px] text-muted-foreground">时间：{item.date || '未知'}</div>
                  <div className="text-[10px] text-muted-foreground">
                    UID: {item.uid} | {item.size} bytes | {item.seen ? '已读' : '未读'}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => void openMessageDetail(item)}
                    >
                      查看详情
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => handleQuickReply(item)}
                    >
                      快捷回复
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      ) : (
        <section className="space-y-3 rounded-xl border border-black/10 bg-white/80 p-4 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
              <Send className="h-4 w-4" />
              代发邮件
            </h2>
            <Button type="button" size="sm" onClick={() => void handleSendMail()} disabled={sending || !activeAccount}>
              {sending ? '发送中...' : '发送'}
            </Button>
          </div>

          <div className="space-y-2">
            <Label>收件人 To</Label>
            <Input value={to} onChange={(event) => setTo(event.target.value)} placeholder="a@x.com,b@y.com" />
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div className="space-y-2">
              <Label>抄送 Cc</Label>
              <Input value={cc} onChange={(event) => setCc(event.target.value)} placeholder="可选" />
            </div>
            <div className="space-y-2">
              <Label>密送 Bcc</Label>
              <Input value={bcc} onChange={(event) => setBcc(event.target.value)} placeholder="可选" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>主题</Label>
            <Input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="邮件主题" />
          </div>
          <div className="space-y-2">
            <Label>正文</Label>
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="输入邮件正文"
              className="min-h-[180px]"
            />
          </div>
        </section>
      )}

      {accountModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          onClick={() => setAccountModalOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-xl border border-black/10 bg-background p-4 shadow-2xl dark:border-white/10"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
                <Mail className="h-4 w-4" />
                {form.id ? '编辑邮箱账号' : '新建邮箱账号'}
              </h2>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAccountModalOpen(false)}>
                关闭
              </Button>
            </div>

            <div className="max-h-[68vh] space-y-3 overflow-auto pr-1">
              <div className="space-y-2">
                <Label>账号标签</Label>
                <Input
                  value={form.label}
                  onChange={(event) => setForm((prev) => ({ ...prev, label: event.target.value }))}
                  placeholder="例如：工作邮箱"
                />
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>发件邮箱</Label>
                  <Input
                    value={form.email}
                    onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
                    placeholder="name@example.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label>登录用户名</Label>
                  <Input
                    value={form.username}
                    onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
                    placeholder="通常与邮箱一致"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{form.id ? '密码（留空则不变）' : '密码 / 授权码'}</Label>
                <Input
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                  placeholder="请输入密码或 SMTP/IMAP 授权码"
                />
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>IMAP Host</Label>
                  <Input
                    value={form.imapHost}
                    onChange={(event) => setForm((prev) => ({ ...prev, imapHost: event.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>IMAP Port</Label>
                  <Input
                    type="number"
                    value={form.imapPort}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, imapPort: Number(event.target.value || 0) }))
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>SMTP Host</Label>
                  <Input
                    value={form.smtpHost}
                    onChange={(event) => setForm((prev) => ({ ...prev, smtpHost: event.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>SMTP Port</Label>
                  <Input
                    type="number"
                    value={form.smtpPort}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, smtpPort: Number(event.target.value || 0) }))
                    }
                  />
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={form.imapTls}
                    onCheckedChange={(checked) => setForm((prev) => ({ ...prev, imapTls: checked }))}
                  />
                  <span className="text-[12px] text-muted-foreground">IMAP TLS</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={form.smtpTls}
                    onCheckedChange={(checked) => setForm((prev) => ({ ...prev, smtpTls: checked }))}
                  />
                  <span className="text-[12px] text-muted-foreground">SMTP TLS</span>
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              {form.id ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => void handleDeleteAccount(form.id as string)}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  删除账号
                </Button>
              ) : (
                <span />
              )}
              <Button type="button" onClick={() => void handleSaveAccount()} disabled={savingAccount}>
                {savingAccount ? '保存中...' : '保存账号'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {selectedMessage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          onClick={() => {
            setSelectedMessage(null);
            setSelectedMessageDetail(null);
          }}
        >
          <div
            className="w-full max-w-2xl rounded-xl border border-black/10 bg-background p-4 shadow-2xl dark:border-white/10"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-foreground">邮件详情</h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedMessage(null);
                  setSelectedMessageDetail(null);
                }}
              >
                关闭
              </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-black/10 p-3 text-[12px] dark:border-white/10">
              <div><span className="text-muted-foreground">主题：</span>{(selectedMessageDetail || selectedMessage).subject || '(无主题)'}</div>
              <div><span className="text-muted-foreground">发件人：</span>{(selectedMessageDetail || selectedMessage).from || '未知'}</div>
              <div><span className="text-muted-foreground">收件人：</span>{(selectedMessageDetail || selectedMessage).to || '未知'}</div>
              <div><span className="text-muted-foreground">时间：</span>{(selectedMessageDetail || selectedMessage).date || '未知'}</div>
              <div><span className="text-muted-foreground">大小：</span>{(selectedMessageDetail || selectedMessage).size} bytes</div>
              <div><span className="text-muted-foreground">UID：</span>{(selectedMessageDetail || selectedMessage).uid}</div>
              <div className="pt-2">
                <div className="mb-1 text-muted-foreground">正文：</div>
                {loadingMessageDetail ? (
                  <div className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md border border-black/10 bg-black/[0.02] p-2 text-[12px] leading-5 dark:border-white/10 dark:bg-white/[0.03]">
                    加载中...
                  </div>
                ) : bodyRender.kind === 'html' ? (
                  <iframe
                    title="邮件正文"
                    className="h-[320px] w-full rounded-md border border-black/10 bg-white dark:border-white/10 dark:bg-white"
                    sandbox=""
                    srcDoc={bodyRender.value}
                  />
                ) : (
                  <div className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md border border-black/10 bg-black/[0.02] p-2 text-[12px] leading-5 dark:border-white/10 dark:bg-white/[0.03]">
                    {bodyRender.kind === 'empty'
                      ? '未获取到正文内容（可能是 HTML 多段内容未命中，可先导出到本地查看）'
                      : bodyRender.value}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <Button type="button" onClick={() => handleQuickReply(selectedMessageDetail || selectedMessage)}>
                快捷回复
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
