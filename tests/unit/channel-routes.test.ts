import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const listConfiguredChannelsMock = vi.fn();
const listConfiguredChannelAccountsMock = vi.fn();
const readOpenClawConfigMock = vi.fn();
const listAgentsSnapshotMock = vi.fn();
const sendJsonMock = vi.fn();
const readFileMock = vi.fn();
const readdirMock = vi.fn();

vi.mock('@electron/utils/channel-config', () => ({
  cleanupDanglingWeChatPluginState: vi.fn(),
  deleteChannelAccountConfig: vi.fn(),
  deleteChannelConfig: vi.fn(),
  getChannelFormValues: vi.fn(),
  listConfiguredChannelAccounts: (...args: unknown[]) => listConfiguredChannelAccountsMock(...args),
  listConfiguredChannels: (...args: unknown[]) => listConfiguredChannelsMock(...args),
  readOpenClawConfig: (...args: unknown[]) => readOpenClawConfigMock(...args),
  saveChannelConfig: vi.fn(),
  setChannelDefaultAccount: vi.fn(),
  setChannelEnabled: vi.fn(),
  validateChannelConfig: vi.fn(),
  validateChannelCredentials: vi.fn(),
}));

vi.mock('@electron/utils/agent-config', () => ({
  assignChannelAccountToAgent: vi.fn(),
  clearAllBindingsForChannel: vi.fn(),
  clearChannelBinding: vi.fn(),
  listAgentsSnapshot: (...args: unknown[]) => listAgentsSnapshotMock(...args),
}));

vi.mock('@electron/utils/plugin-install', () => ({
  ensureDingTalkPluginInstalled: vi.fn(),
  ensureFeishuPluginInstalled: vi.fn(),
  ensureQQBotPluginInstalled: vi.fn(),
  ensureWeChatPluginInstalled: vi.fn(),
  ensureWeComPluginInstalled: vi.fn(),
}));

vi.mock('@electron/utils/wechat-login', () => ({
  cancelWeChatLoginSession: vi.fn(),
  saveWeChatAccountState: vi.fn(),
  startWeChatLoginSession: vi.fn(),
  waitForWeChatLoginSession: vi.fn(),
}));

vi.mock('@electron/utils/whatsapp-login', () => ({
  whatsAppLoginManager: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: vi.fn().mockResolvedValue({}),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  readdir: (...args: unknown[]) => readdirMock(...args),
  default: {
    readFile: (...args: unknown[]) => readFileMock(...args),
    readdir: (...args: unknown[]) => readdirMock(...args),
  },
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => '/tmp/openclaw',
}));

describe('handleChannelRoutes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readFileMock.mockResolvedValue('');
    readdirMock.mockResolvedValue([]);
    listAgentsSnapshotMock.mockResolvedValue({
      agents: [],
      channelAccountOwners: {},
    });
    readOpenClawConfigMock.mockResolvedValue({
      channels: {},
    });
  });

  it('reports healthy running multi-account channels as connected', async () => {
    listConfiguredChannelsMock.mockResolvedValue(['feishu']);
    listConfiguredChannelAccountsMock.mockResolvedValue({
      feishu: {
        defaultAccountId: 'default',
        accountIds: ['default', 'feishu-2412524e'],
      },
    });
    readOpenClawConfigMock.mockResolvedValue({
      channels: {
        feishu: {
          defaultAccount: 'default',
        },
      },
    });
    listAgentsSnapshotMock.mockResolvedValue({
      agents: [],
      channelAccountOwners: {
        'feishu:default': 'main',
        'feishu:feishu-2412524e': 'code',
      },
    });

    const rpc = vi.fn().mockResolvedValue({
      channels: {
        feishu: {
          configured: true,
        },
      },
      channelAccounts: {
        feishu: [
          {
            accountId: 'default',
            configured: true,
            connected: false,
            running: true,
            linked: false,
          },
          {
            accountId: 'feishu-2412524e',
            configured: true,
            connected: false,
            running: true,
            linked: false,
          },
        ],
      },
      channelDefaultAccountId: {
        feishu: 'default',
      },
    });

    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    const handled = await handleChannelRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/accounts?force=1'),
      {
        gatewayManager: {
          rpc,
          getStatus: () => ({ state: 'running' }),
          debouncedReload: vi.fn(),
          debouncedRestart: vi.fn(),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpc).toHaveBeenCalledWith('channels.status', { probe: false });
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        channels: [
          expect.objectContaining({
            channelType: 'feishu',
            status: 'connected',
            accounts: expect.arrayContaining([
              expect.objectContaining({ accountId: 'default', status: 'connected' }),
              expect.objectContaining({ accountId: 'feishu-2412524e', status: 'connected' }),
            ]),
          }),
        ],
      }),
    );
  });

  it('keeps channel connected when one account is healthy and another errors', async () => {
    listConfiguredChannelsMock.mockResolvedValue(['telegram']);
    listConfiguredChannelAccountsMock.mockResolvedValue({
      telegram: {
        defaultAccountId: 'default',
        accountIds: ['default', 'telegram-b'],
      },
    });
    readOpenClawConfigMock.mockResolvedValue({
      channels: {
        telegram: {
          defaultAccount: 'default',
        },
      },
    });

    const rpc = vi.fn().mockResolvedValue({
      channels: {
        telegram: {
          configured: true,
        },
      },
      channelAccounts: {
        telegram: [
          {
            accountId: 'default',
            configured: true,
            connected: true,
            running: true,
            linked: false,
          },
          {
            accountId: 'telegram-b',
            configured: true,
            connected: false,
            running: false,
            linked: false,
            lastError: 'secondary bot failed',
          },
        ],
      },
      channelDefaultAccountId: {
        telegram: 'default',
      },
    });

    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    await handleChannelRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/accounts?force=1'),
      {
        gatewayManager: {
          rpc,
          getStatus: () => ({ state: 'running' }),
          debouncedReload: vi.fn(),
          debouncedRestart: vi.fn(),
        },
      } as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        channels: [
          expect.objectContaining({
            channelType: 'telegram',
            status: 'connected',
            accounts: expect.arrayContaining([
              expect.objectContaining({ accountId: 'default', status: 'connected' }),
              expect.objectContaining({ accountId: 'telegram-b', status: 'error' }),
            ]),
          }),
        ],
      }),
    );
  });

  it('loads recipient options from openclaw sessions and config json', async () => {
    readOpenClawConfigMock.mockResolvedValue({
      channels: {
        feishu: {
          accounts: {
            default: {
              defaultRecipientId: 'ou_config',
            },
          },
        },
      },
    });
    readdirMock.mockResolvedValue([
      { isDirectory: () => true, name: 'main' },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        'agent:main:feishu:direct:ou_session': {
          updatedAt: 1710000000000,
          origin: {
            accountId: 'default',
            to: 'ou_session',
          },
        },
      })
    );

    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    const handled = await handleChannelRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/recipient-options?channelType=feishu&accountId=default'),
      {
        gatewayManager: {
          rpc: vi.fn(),
          getStatus: () => ({ state: 'running' }),
          debouncedReload: vi.fn(),
          debouncedRestart: vi.fn(),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      {
        success: true,
        recipients: ['ou_config', 'ou_session'],
      },
    );
  });

  it('loads pairing requests and filters by account id', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        version: 1,
        requests: [
          {
            id: 'ou_default_1',
            code: 'ABCD1234',
            createdAt: '2026-03-31T09:00:00.000Z',
            lastSeenAt: '2026-03-31T09:30:00.000Z',
            meta: {
              accountId: 'default',
              userId: 'ou_default_1',
            },
          },
          {
            id: 'ou_other_1',
            code: 'WXYZ7890',
            createdAt: '2026-03-31T10:00:00.000Z',
            meta: {
              accountId: 'other',
            },
          },
        ],
      }),
    );

    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    const handled = await handleChannelRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/pairing-requests?channelType=feishu&accountId=default'),
      {
        gatewayManager: {
          rpc: vi.fn(),
          getStatus: () => ({ state: 'running' }),
          debouncedReload: vi.fn(),
          debouncedRestart: vi.fn(),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(readFileMock).toHaveBeenCalledWith(
      '/tmp/openclaw/credentials/feishu-pairing.json',
      'utf8',
    );
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      {
        success: true,
        requests: [
          {
            id: 'ou_default_1',
            userId: 'ou_default_1',
            code: 'ABCD1234',
            createdAt: '2026-03-31T09:00:00.000Z',
            lastSeenAt: '2026-03-31T09:30:00.000Z',
            accountId: 'default',
            meta: {
              accountId: 'default',
              userId: 'ou_default_1',
            },
          },
        ],
      },
    );
  });
});
