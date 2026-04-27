import type { IncomingMessage, ServerResponse } from 'http';
import {
  deleteMailAccount,
  listMailAccounts,
  fetchMailDetail,
  getStoredMailDetail,
  listStoredMails,
  exportStoredMailsToWorkspace,
  receiveUnreadMails,
  sendMail,
  upsertMailAccount,
  type MailAccountInput,
  type MailSendInput,
} from '../../services/mail/mail-service';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleMailRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  void ctx;

  if (url.pathname === '/api/mail/accounts' && req.method === 'GET') {
    try {
      const accounts = await listMailAccounts();
      sendJson(res, 200, { success: true, accounts });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/mail/accounts' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<MailAccountInput>(req);
      const account = await upsertMailAccount(body);
      sendJson(res, 200, { success: true, account });
    } catch (error) {
      sendJson(res, 400, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/mail/accounts/') && req.method === 'DELETE') {
    try {
      const accountId = decodeURIComponent(url.pathname.slice('/api/mail/accounts/'.length));
      if (!accountId) {
        throw new Error('accountId is required');
      }
      await deleteMailAccount(accountId);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 400, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/mail/receive' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ accountId: string; limit?: number }>(req);
      if (!body.accountId) {
        throw new Error('accountId is required');
      }
      const messages = await receiveUnreadMails(body.accountId, body.limit ?? 20);
      sendJson(res, 200, { success: true, messages });
    } catch (error) {
      sendJson(res, 400, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/mail/messages' && req.method === 'GET') {
    try {
      const accountId = url.searchParams.get('accountId') || '';
      const limitRaw = Number(url.searchParams.get('limit') || '50');
      if (!accountId) {
        throw new Error('accountId is required');
      }
      const messages = await listStoredMails(accountId, limitRaw);
      sendJson(res, 200, { success: true, messages });
    } catch (error) {
      sendJson(res, 400, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/mail/send' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<MailSendInput>(req);
      await sendMail(body);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 400, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/mail/detail' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ accountId: string; uid: string; useCache?: boolean }>(req);
      if (!body.accountId) {
        throw new Error('accountId is required');
      }
      if (!body.uid) {
        throw new Error('uid is required');
      }
      let detail = body.useCache ? await getStoredMailDetail(body.accountId, body.uid) : null;
      if (!detail) {
        detail = await fetchMailDetail(body.accountId, body.uid);
      }
      sendJson(res, 200, { success: true, detail });
    } catch (error) {
      sendJson(res, 400, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/mail/export' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ accountId: string; limit?: number }>(req);
      if (!body.accountId) {
        throw new Error('accountId is required');
      }
      const result = await exportStoredMailsToWorkspace(body.accountId, body.limit ?? 100);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      sendJson(res, 400, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
