// Lazy-load electron-store (ESM module) from the main process only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mailStore: any = null;

export interface MailAccountRecord {
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
}

interface MailStoreShape {
  accounts: Record<string, MailAccountRecord>;
  passwords: Record<string, string>;
  inboxCache: Record<string, unknown[]>;
  detailCache: Record<string, Record<string, unknown>>;
}

export async function getMailStore() {
  if (!mailStore) {
    const Store = (await import('electron-store')).default;
    mailStore = new Store<MailStoreShape>({
      name: 'clawx-mail',
      defaults: {
        accounts: {},
        passwords: {},
        inboxCache: {},
        detailCache: {},
      },
    });
  }

  return mailStore;
}
