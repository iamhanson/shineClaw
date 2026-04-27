import { Socket } from 'node:net';
import tls from 'node:tls';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expandPath, getOpenClawConfigDir } from '../../utils/paths';
import { getMailStore, type MailAccountRecord } from './store-instance';

type Buffered = { value: string };

export interface MailAccountInput {
  id?: string;
  label: string;
  email: string;
  username: string;
  password?: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
}

export interface MailAccountView extends MailAccountRecord {
  hasPassword: boolean;
}

export interface ReceivedMailItem {
  uid: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  size: number;
  seen: boolean;
}

export interface MailDetail extends ReceivedMailItem {
  bodyText: string;
}

export interface MailExportResult {
  dir: string;
  indexFile: string;
  exportedCount: number;
}

export interface MailSendInput {
  accountId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  content: string;
}

const CONNECT_TIMEOUT_MS = 12_000;
const IO_TIMEOUT_MS = 20_000;

function timeoutError(message: string): Error {
  return new Error(message);
}

function normalizeLineBreaks(input: string): string {
  return input.replace(/\r?\n/g, '\r\n');
}

function escapeImapQuoted(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function ensureNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function parseIntPort(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${field} must be a valid port`);
  }
  return value;
}

function encodeHeaderMimeWord(value: string): string {
  if (!value) return '';
  if (/^[\x20-\x7E]+$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function decodeQEncoding(value: string): string {
  const replaced = value.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return Buffer.from(replaced, 'binary').toString('utf8');
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, encoding: string, data: string) => {
    const cs = charset.toLowerCase();
    if (cs !== 'utf-8' && cs !== 'utf8') {
      return data;
    }
    if (encoding.toLowerCase() === 'b') {
      return Buffer.from(data, 'base64').toString('utf8');
    }
    return decodeQEncoding(data);
  });
}

function decodeQuotedPrintable(input: string): string {
  const normalized = input.replace(/=\r?\n/g, '');
  const binary = normalized.replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return Buffer.from(binary, 'binary').toString('utf8');
}

function decodeTransferEncodedBody(body: string, transferEncoding?: string): string {
  const encoding = (transferEncoding || '').trim().toLowerCase();
  if (!encoding) return body;

  if (encoding.includes('quoted-printable')) {
    return decodeQuotedPrintable(body);
  }

  if (encoding.includes('base64')) {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }

  return body;
}

function extractBoundary(contentType?: string): string | null {
  if (!contentType) return null;
  const quoted = contentType.match(/boundary="([^"]+)"/i)?.[1];
  if (quoted) return quoted;
  const bare = contentType.match(/boundary=([^;]+)/i)?.[1];
  return bare ? bare.trim() : null;
}

type ParsedMailPart = {
  contentType: string;
  body: string;
};

function parseRawMailPart(raw: string): ParsedMailPart {
  const normalized = raw.replace(/\r?\n/g, '\r\n');
  const splitIndex = normalized.indexOf('\r\n\r\n');
  if (splitIndex < 0) {
    return { contentType: 'text/plain', body: raw.trim() };
  }

  const headerText = normalized.slice(0, splitIndex);
  const bodyText = normalized.slice(splitIndex + 4);
  const headers = parseHeaders(headerText);
  const contentType = headers['content-type'] || 'text/plain';
  const transferEncoding = headers['content-transfer-encoding'] || '';

  return {
    contentType,
    body: decodeTransferEncodedBody(bodyText, transferEncoding).trim(),
  };
}

function extractPreferredBody(raw: string): string {
  const normalized = raw.replace(/\r?\n/g, '\r\n').trim();
  if (!normalized) return '';

  const root = parseRawMailPart(normalized);
  const boundary = extractBoundary(root.contentType);
  if (!boundary || !/multipart\//i.test(root.contentType)) {
    return root.body;
  }

  const marker = `--${boundary}`;
  const parts = root.body
    .split(marker)
    .map((part) => part.trim())
    .filter((part) => part && part !== '--');

  let plainText = '';
  for (const part of parts) {
    const cleaned = part.replace(/--\s*$/, '').trim();
    if (!cleaned) continue;
    const parsed = parseRawMailPart(cleaned);
    if (/multipart\//i.test(parsed.contentType)) {
      const nested = extractPreferredBody(cleaned);
      if (nested && !plainText) plainText = nested;
      if (/<([a-z][\w-]*)(\s[^>]*)?>/i.test(nested)) {
        return nested;
      }
      continue;
    }

    if (/text\/html/i.test(parsed.contentType)) {
      return parsed.body;
    }

    if (/text\/plain/i.test(parsed.contentType) && !plainText) {
      plainText = parsed.body;
    }
  }

  return plainText || root.body;
}

function parseRecipientList(input?: string): string[] {
  if (!input) return [];
  return input
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

type OpenClawConfigDocument = {
  agents?: {
    defaults?: {
      workspace?: unknown;
    };
  };
};

async function resolveWorkspaceDir(): Promise<string> {
  const configPath = join(getOpenClawConfigDir(), 'openclaw.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as OpenClawConfigDocument;
    const configured = parsed?.agents?.defaults?.workspace;
    if (typeof configured === 'string' && configured.trim()) {
      return expandPath(configured.trim());
    }
  } catch {
    // fall back to default
  }
  return join(getOpenClawConfigDir(), 'workspace');
}

function parseHeaders(rawHeaders: string): Record<string, string> {
  const normalized = rawHeaders.replace(/\r\n[ \t]+/g, ' ');
  const rows = normalized.split('\r\n');
  const parsed: Record<string, string> = {};
  for (const row of rows) {
    const idx = row.indexOf(':');
    if (idx <= 0) continue;
    const key = row.slice(0, idx).trim().toLowerCase();
    const value = row.slice(idx + 1).trim();
    if (!parsed[key]) {
      parsed[key] = decodeMimeWords(value);
    }
  }
  return parsed;
}

function getMatchWithReset(regex: RegExp, value: string): RegExpExecArray | null {
  regex.lastIndex = 0;
  return regex.exec(value);
}

async function connectSocket(
  host: string,
  port: number,
  tlsEnabled: boolean,
): Promise<Socket | tls.TLSSocket> {
  return await new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };

    if (tlsEnabled) {
      const socket = tls.connect(
        {
          host,
          port,
          servername: host,
        },
        () => {
          socket.removeListener('error', onError);
          resolve(socket);
        },
      );

      socket.once('error', onError);
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
        socket.destroy(timeoutError(`Connect timeout: ${host}:${port}`));
      });
      return;
    }

    const socket = new Socket();
    socket.once('error', onError);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy(timeoutError(`Connect timeout: ${host}:${port}`));
    });
    socket.connect(port, host, () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

async function writeLine(socket: Socket | tls.TLSSocket, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(line, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readUntilPattern(
  socket: Socket | tls.TLSSocket,
  buffered: Buffered,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const immediate = getMatchWithReset(pattern, buffered.value);
  if (immediate) {
    const end = (immediate.index ?? 0) + immediate[0].length;
    const chunk = buffered.value.slice(0, end);
    buffered.value = buffered.value.slice(end);
    return chunk;
  }

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(timeoutError('Socket read timeout'));
    }, timeoutMs);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('end', onEnd);
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    const check = () => {
      const match = getMatchWithReset(pattern, buffered.value);
      if (!match) return;
      const end = (match.index ?? 0) + match[0].length;
      const chunk = buffered.value.slice(0, end);
      buffered.value = buffered.value.slice(end);
      cleanup();
      resolve(chunk);
    };

    const onData = (raw: Buffer) => {
      buffered.value += raw.toString('utf8');
      check();
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error('Socket closed unexpectedly'));
    const onEnd = () => fail(new Error('Socket ended unexpectedly'));

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('end', onEnd);
    check();
  });
}

async function sendImapCommand(
  socket: Socket | tls.TLSSocket,
  buffered: Buffered,
  tag: string,
  command: string,
): Promise<{ status: 'OK' | 'NO' | 'BAD'; response: string }> {
  await writeLine(socket, `${tag} ${command}\r\n`);
  const pattern = new RegExp(`(?:^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`);
  const response = await readUntilPattern(socket, buffered, pattern, IO_TIMEOUT_MS);
  const statusMatch = response.match(new RegExp(`${tag} (OK|NO|BAD)`));
  if (!statusMatch) {
    throw new Error('Invalid IMAP response');
  }
  return { status: statusMatch[1] as 'OK' | 'NO' | 'BAD', response };
}

function getAccountId(): string {
  return `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toAccountView(
  account: MailAccountRecord,
  passwordById: Record<string, string>,
): MailAccountView {
  return {
    ...account,
    hasPassword: Boolean(passwordById[account.id]),
  };
}

function normalizeCachedMailItem(raw: unknown): ReceivedMailItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<ReceivedMailItem>;
  if (!item.uid || typeof item.uid !== 'string') return null;
  return {
    uid: item.uid,
    subject: typeof item.subject === 'string' ? item.subject : '(无主题)',
    from: typeof item.from === 'string' ? item.from : '',
    to: typeof item.to === 'string' ? item.to : '',
    date: typeof item.date === 'string' ? item.date : '',
    size: typeof item.size === 'number' ? item.size : 0,
    seen: Boolean(item.seen),
  };
}

function normalizeCachedMailDetail(raw: unknown): MailDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const base = normalizeCachedMailItem(raw);
  if (!base) return null;
  const bodyText = typeof (raw as Partial<MailDetail>).bodyText === 'string'
    ? (raw as Partial<MailDetail>).bodyText || ''
    : '';
  return {
    ...base,
    bodyText,
  };
}

async function saveInboxCache(accountId: string, items: ReceivedMailItem[]): Promise<void> {
  const store = await getMailStore();
  const cache = (store.get('inboxCache') ?? {}) as Record<string, unknown[]>;
  const existing = (cache[accountId] ?? [])
    .map(normalizeCachedMailItem)
    .filter((item): item is ReceivedMailItem => Boolean(item));
  const byUid = new Map<string, ReceivedMailItem>();
  for (const item of existing) {
    byUid.set(item.uid, item);
  }
  for (const item of items) {
    byUid.set(item.uid, item);
  }
  const merged = Array.from(byUid.values())
    .sort((a, b) => Number(b.uid) - Number(a.uid))
    .slice(0, 300);
  cache[accountId] = merged;
  store.set('inboxCache', cache);
}

async function saveDetailCache(accountId: string, detail: MailDetail): Promise<void> {
  const store = await getMailStore();
  const detailCache = (store.get('detailCache') ?? {}) as Record<string, Record<string, unknown>>;
  const byUid = detailCache[accountId] ?? {};
  byUid[detail.uid] = detail;
  detailCache[accountId] = byUid;
  store.set('detailCache', detailCache);
}

async function getAccountAndPassword(accountId: string): Promise<{ account: MailAccountRecord; password: string }> {
  const store = await getMailStore();
  const accounts = (store.get('accounts') ?? {}) as Record<string, MailAccountRecord>;
  const passwords = (store.get('passwords') ?? {}) as Record<string, string>;
  const account = accounts[accountId];
  if (!account) {
    throw new Error('Mail account not found');
  }
  const password = passwords[accountId];
  if (!password) {
    throw new Error('Mail account password not configured');
  }
  return { account, password };
}

export async function listMailAccounts(): Promise<MailAccountView[]> {
  const store = await getMailStore();
  const accounts = (store.get('accounts') ?? {}) as Record<string, MailAccountRecord>;
  const passwords = (store.get('passwords') ?? {}) as Record<string, string>;
  return Object.values(accounts)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((account) => toAccountView(account, passwords));
}

export async function upsertMailAccount(input: MailAccountInput): Promise<MailAccountView> {
  const now = new Date().toISOString();
  const accountId = input.id?.trim() || getAccountId();
  const store = await getMailStore();
  const accounts = (store.get('accounts') ?? {}) as Record<string, MailAccountRecord>;
  const passwords = (store.get('passwords') ?? {}) as Record<string, string>;
  const existing = accounts[accountId];

  const account: MailAccountRecord = {
    id: accountId,
    label: ensureNonEmpty(input.label, 'label'),
    email: ensureNonEmpty(input.email, 'email'),
    username: ensureNonEmpty(input.username, 'username'),
    imapHost: ensureNonEmpty(input.imapHost, 'imapHost'),
    imapPort: parseIntPort(input.imapPort, 'imapPort'),
    imapTls: Boolean(input.imapTls),
    smtpHost: ensureNonEmpty(input.smtpHost, 'smtpHost'),
    smtpPort: parseIntPort(input.smtpPort, 'smtpPort'),
    smtpTls: Boolean(input.smtpTls),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  accounts[accountId] = account;
  store.set('accounts', accounts);

  if (typeof input.password === 'string' && input.password.trim()) {
    passwords[accountId] = input.password;
    store.set('passwords', passwords);
  } else if (!existing) {
    throw new Error('password is required for new account');
  }

  return toAccountView(account, passwords);
}

export async function deleteMailAccount(accountId: string): Promise<void> {
  const store = await getMailStore();
  const accounts = (store.get('accounts') ?? {}) as Record<string, MailAccountRecord>;
  const passwords = (store.get('passwords') ?? {}) as Record<string, string>;
  const inboxCache = (store.get('inboxCache') ?? {}) as Record<string, unknown[]>;
  const detailCache = (store.get('detailCache') ?? {}) as Record<string, Record<string, unknown>>;

  delete accounts[accountId];
  delete passwords[accountId];
  delete inboxCache[accountId];
  delete detailCache[accountId];

  store.set('accounts', accounts);
  store.set('passwords', passwords);
  store.set('inboxCache', inboxCache);
  store.set('detailCache', detailCache);
}

export async function listStoredMails(accountId: string, limit = 50): Promise<ReceivedMailItem[]> {
  const safeLimit = Math.max(1, Math.min(300, Math.floor(limit)));
  const store = await getMailStore();
  const cache = (store.get('inboxCache') ?? {}) as Record<string, unknown[]>;
  const rows = (cache[accountId] ?? [])
    .map(normalizeCachedMailItem)
    .filter((item): item is ReceivedMailItem => Boolean(item))
    .sort((a, b) => Number(b.uid) - Number(a.uid))
    .slice(0, safeLimit);
  return rows;
}

export async function getStoredMailDetail(accountId: string, uid: string): Promise<MailDetail | null> {
  const store = await getMailStore();
  const detailCache = (store.get('detailCache') ?? {}) as Record<string, Record<string, unknown>>;
  const detail = detailCache[accountId]?.[uid];
  return normalizeCachedMailDetail(detail);
}

export async function exportStoredMailsToWorkspace(accountId: string, limit = 100): Promise<MailExportResult> {
  const store = await getMailStore();
  const accounts = (store.get('accounts') ?? {}) as Record<string, MailAccountRecord>;
  const account = accounts[accountId];
  if (!account) {
    throw new Error('Mail account not found');
  }
  const mails = await listStoredMails(accountId, limit);
  const workspaceDir = await resolveWorkspaceDir();
  const exportDir = join(workspaceDir, 'mailbox', account.id);
  await mkdir(exportDir, { recursive: true });

  const detailLines: string[] = [];
  for (const mail of mails) {
    const detail = await getStoredMailDetail(accountId, mail.uid);
    const fileName = `${mail.uid}.md`;
    const filePath = join(exportDir, fileName);
    const content = [
      `# ${mail.subject || '(无主题)'}`,
      '',
      `- UID: ${mail.uid}`,
      `- From: ${mail.from || ''}`,
      `- To: ${mail.to || ''}`,
      `- Date: ${mail.date || ''}`,
      `- Size: ${mail.size} bytes`,
      `- Seen: ${mail.seen ? 'true' : 'false'}`,
      '',
      '## Body',
      '',
      detail?.bodyText?.trim() || '(暂无正文缓存，先在应用中点击“查看详情”可补全)',
      '',
    ].join('\n');
    await writeFile(filePath, content, 'utf-8');
    detailLines.push(`- [${mail.uid}.md](./${mail.uid}.md) | ${mail.subject || '(无主题)'} | ${mail.date || ''}`);
  }

  const indexFile = join(exportDir, 'index.md');
  const indexContent = [
    `# 邮件导出 - ${account.label} (${account.email})`,
    '',
    `导出时间: ${new Date().toISOString()}`,
    '',
    `总数: ${mails.length}`,
    '',
    '## 列表',
    '',
    ...(detailLines.length > 0 ? detailLines : ['(暂无邮件缓存，请先点击“收取未读”)']),
    '',
  ].join('\n');
  await writeFile(indexFile, indexContent, 'utf-8');

  return {
    dir: exportDir,
    indexFile,
    exportedCount: mails.length,
  };
}

export async function receiveUnreadMails(accountId: string, limit = 20): Promise<ReceivedMailItem[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const { account, password } = await getAccountAndPassword(accountId);
  const socket = await connectSocket(account.imapHost, account.imapPort, account.imapTls);
  const buffered: Buffered = { value: '' };
  let tagCounter = 1;
  const nextTag = () => `A${String(tagCounter++).padStart(4, '0')}`;

  try {
    await readUntilPattern(socket, buffered, /\* (OK|PREAUTH)[^\r\n]*\r\n/, IO_TIMEOUT_MS);

    const login = await sendImapCommand(
      socket,
      buffered,
      nextTag(),
      `LOGIN "${escapeImapQuoted(account.username)}" "${escapeImapQuoted(password)}"`,
    );
    if (login.status !== 'OK') {
      throw new Error('IMAP login failed');
    }

    const selectResp = await sendImapCommand(socket, buffered, nextTag(), 'SELECT INBOX');
    if (selectResp.status !== 'OK') {
      throw new Error('IMAP select INBOX failed');
    }

    const searchResp = await sendImapCommand(socket, buffered, nextTag(), 'UID SEARCH UNSEEN');
    if (searchResp.status !== 'OK') {
      throw new Error('IMAP search unread failed');
    }

    const searchMatch = searchResp.response.match(/\* SEARCH([^\r\n]*)\r\n/);
    const uids = (searchMatch?.[1] || '')
      .trim()
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (uids.length === 0) {
      await sendImapCommand(socket, buffered, nextTag(), 'LOGOUT');
      socket.end();
      return [];
    }

    const targetUids = uids.slice(-safeLimit);
    const fetchResp = await sendImapCommand(
      socket,
      buffered,
      nextTag(),
      `UID FETCH ${targetUids.join(',')} (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE)])`,
    );
    if (fetchResp.status !== 'OK') {
      throw new Error('IMAP fetch unread failed');
    }

    await sendImapCommand(socket, buffered, nextTag(), 'LOGOUT');
    socket.end();

    const blockRegex = /\* \d+ FETCH \(([\s\S]*?)\)\r\n/g;
    const rows: ReceivedMailItem[] = [];
    let blockMatch: RegExpExecArray | null = blockRegex.exec(fetchResp.response);
    while (blockMatch) {
      const block = blockMatch[1] || '';
      const uid = block.match(/\bUID (\d+)/)?.[1] || '';
      if (uid) {
        const size = Number(block.match(/\bRFC822\.SIZE (\d+)/)?.[1] || '0');
        const flagsText = block.match(/\bFLAGS \(([^)]*)\)/)?.[1] || '';
        const seen = /\\Seen/.test(flagsText);
        const headerBlock = block.match(/BODY\[HEADER\.FIELDS[^\]]*\] \{\d+\}\r\n([\s\S]*)$/)?.[1] || '';
        const headers = parseHeaders(headerBlock);
        rows.push({
          uid,
          subject: headers.subject || '(无主题)',
          from: headers.from || '',
          to: headers.to || '',
          date: headers.date || '',
          size,
          seen,
        });
      }
      blockMatch = blockRegex.exec(fetchResp.response);
    }

    const sorted = rows.sort((a, b) => Number(b.uid) - Number(a.uid));
    await saveInboxCache(accountId, sorted);
    return sorted;
  } finally {
    socket.destroy();
  }
}

export async function fetchMailDetail(accountId: string, uid: string): Promise<MailDetail> {
  const normalizedUid = ensureNonEmpty(uid, 'uid');
  const { account, password } = await getAccountAndPassword(accountId);
  const socket = await connectSocket(account.imapHost, account.imapPort, account.imapTls);
  const buffered: Buffered = { value: '' };
  let tagCounter = 1;
  const nextTag = () => `A${String(tagCounter++).padStart(4, '0')}`;

  try {
    await readUntilPattern(socket, buffered, /\* (OK|PREAUTH)[^\r\n]*\r\n/, IO_TIMEOUT_MS);
    const login = await sendImapCommand(
      socket,
      buffered,
      nextTag(),
      `LOGIN "${escapeImapQuoted(account.username)}" "${escapeImapQuoted(password)}"`,
    );
    if (login.status !== 'OK') {
      throw new Error('IMAP login failed');
    }

    const selectResp = await sendImapCommand(socket, buffered, nextTag(), 'SELECT INBOX');
    if (selectResp.status !== 'OK') {
      throw new Error('IMAP select INBOX failed');
    }

    const fetchResp = await sendImapCommand(
      socket,
      buffered,
      nextTag(),
      `UID FETCH ${normalizedUid} (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE)] BODY.PEEK[TEXT]<0.20000>)`,
    );
    if (fetchResp.status !== 'OK') {
      throw new Error('IMAP fetch mail detail failed');
    }

    await sendImapCommand(socket, buffered, nextTag(), 'LOGOUT');
    socket.end();

    const blockMatch = fetchResp.response.match(/\* \d+ FETCH \(([\s\S]*?)\)\r\n/);
    const block = blockMatch?.[1] || '';
    if (!block) {
      throw new Error('Mail detail not found');
    }

    const fetchedUid = block.match(/\bUID (\d+)/)?.[1] || normalizedUid;
    const size = Number(block.match(/\bRFC822\.SIZE (\d+)/)?.[1] || '0');
    const flagsText = block.match(/\bFLAGS \(([^)]*)\)/)?.[1] || '';
    const seen = /\\Seen/.test(flagsText);
    const headerBlock = block.match(/BODY\[HEADER\.FIELDS[^\]]*\] \{\d+\}\r\n([\s\S]*?)\r\n(?:BODY\[TEXT\]<0\.20000> \{|BODY\[TEXT\]<0> \{)/)?.[1]
      || block.match(/BODY\[HEADER\.FIELDS[^\]]*\] \{\d+\}\r\n([\s\S]*)$/)?.[1]
      || '';
    const headers = parseHeaders(headerBlock);
    const bodyMatch = fetchResp.response.match(/BODY\[TEXT\]<0(?:\.20000)?> \{\d+\}\r\n([\s\S]*?)\r\n\)\r\nA\d{4} /);
    const bodyText = extractPreferredBody(bodyMatch?.[1] || '');

    const detail: MailDetail = {
      uid: fetchedUid,
      subject: headers.subject || '(无主题)',
      from: headers.from || '',
      to: headers.to || '',
      date: headers.date || '',
      size,
      seen,
      bodyText,
    };
    await saveDetailCache(accountId, detail);
    await saveInboxCache(accountId, [detail]);
    return detail;
  } finally {
    socket.destroy();
  }
}

interface SmtpResponse {
  code: number;
  raw: string;
}

async function readSmtpResponse(
  socket: Socket | tls.TLSSocket,
  buffered: Buffered,
): Promise<SmtpResponse> {
  const response = await readUntilPattern(socket, buffered, /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/, IO_TIMEOUT_MS);
  const lines = response.split('\r\n').filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const code = Number(last.slice(0, 3));
  if (!Number.isFinite(code)) {
    throw new Error('Invalid SMTP response');
  }
  return { code, raw: response };
}

async function smtpCommand(
  socket: Socket | tls.TLSSocket,
  buffered: Buffered,
  command: string,
  expectedCodes: number[],
): Promise<SmtpResponse> {
  await writeLine(socket, `${command}\r\n`);
  const response = await readSmtpResponse(socket, buffered);
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`SMTP command failed: ${command} -> ${response.code}`);
  }
  return response;
}

export async function sendMail(input: MailSendInput): Promise<void> {
  const toList = parseRecipientList(input.to);
  const ccList = parseRecipientList(input.cc);
  const bccList = parseRecipientList(input.bcc);
  const allRecipients = [...toList, ...ccList, ...bccList];
  if (allRecipients.length === 0) {
    throw new Error('At least one recipient is required');
  }

  const { account, password } = await getAccountAndPassword(input.accountId);
  const socket = await connectSocket(account.smtpHost, account.smtpPort, account.smtpTls);
  const buffered: Buffered = { value: '' };

  try {
    const greeting = await readSmtpResponse(socket, buffered);
    if (greeting.code !== 220) {
      throw new Error('SMTP server is not ready');
    }

    await smtpCommand(socket, buffered, 'EHLO clawx.local', [250]);
    await smtpCommand(socket, buffered, 'AUTH LOGIN', [334]);
    await smtpCommand(socket, buffered, Buffer.from(account.username, 'utf8').toString('base64'), [334]);
    await smtpCommand(socket, buffered, Buffer.from(password, 'utf8').toString('base64'), [235]);

    await smtpCommand(socket, buffered, `MAIL FROM:<${account.email}>`, [250]);
    for (const recipient of allRecipients) {
      await smtpCommand(socket, buffered, `RCPT TO:<${recipient}>`, [250, 251]);
    }
    await smtpCommand(socket, buffered, 'DATA', [354]);

    const headers = [
      `From: <${account.email}>`,
      `To: ${toList.join(', ')}`,
      ccList.length > 0 ? `Cc: ${ccList.join(', ')}` : '',
      `Subject: ${encodeHeaderMimeWord(input.subject || '(无主题)')}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      `Date: ${new Date().toUTCString()}`,
    ]
      .filter(Boolean)
      .join('\r\n');

    const safeBody = normalizeLineBreaks(input.content || '').replace(/\r\n\./g, '\r\n..');
    await writeLine(socket, `${headers}\r\n\r\n${safeBody}\r\n.\r\n`);
    const finalResponse = await readSmtpResponse(socket, buffered);
    if (finalResponse.code !== 250) {
      throw new Error(`SMTP send failed: ${finalResponse.code}`);
    }

    await smtpCommand(socket, buffered, 'QUIT', [221]);
    socket.end();
  } finally {
    socket.destroy();
  }
}
