import { describe, expect, it } from 'vitest';
import {
  buildFallbackChannelDeliveryStateForUpdate,
  buildIsolatedCronPayload,
} from '../../electron/api/routes/cron';

describe('cron route delivery fallback', () => {
  it('builds isolated agentTurn payload without systemEvent fields', () => {
    expect(buildIsolatedCronPayload('run this')).toEqual({
      kind: 'agentTurn',
      message: 'run this',
    });
  });

  it('uses explicit recipient/account when provided', () => {
    const result = buildFallbackChannelDeliveryStateForUpdate({
      targetChannelType: 'feishu',
      bestEffort: true,
      preferredAccountId: 'sales-bot',
      preferredRecipientId: 'ou_123',
    });

    expect(result).toEqual({
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        to: 'ou_123',
        accountId: 'sales-bot',
        bestEffort: true,
      },
      sessionKey: null,
    });
  });

  it('does not reuse mismatched target data when previous session belongs to another channel', () => {
    const result = buildFallbackChannelDeliveryStateForUpdate({
      targetChannelType: 'telegram',
      bestEffort: true,
      previousJob: {
        sessionKey: 'agent:main:feishu:direct:ou_5eea60f692ffd74100610029529c1369',
        delivery: {
          mode: 'announce',
          channel: 'telegram',
          to: 'user:ou_5eea60f692ffd74100610029529c1369',
          accountId: 'default',
          bestEffort: false,
        },
      },
    });

    expect(result).toEqual({
      delivery: {
        mode: 'announce',
        channel: 'telegram',
        to: null,
        accountId: null,
        bestEffort: true,
      },
      sessionKey: null,
    });
  });

  it('reuses previous target when previous session actually belongs to the same channel', () => {
    const result = buildFallbackChannelDeliveryStateForUpdate({
      targetChannelType: 'feishu',
      bestEffort: false,
      previousJob: {
        sessionKey: 'agent:main:feishu:direct:ou_5eea60f692ffd74100610029529c1369',
        delivery: {
          mode: 'announce',
          channel: 'feishu',
          to: 'user:ou_5eea60f692ffd74100610029529c1369',
          accountId: 'default',
          bestEffort: false,
        },
      },
    });

    expect(result).toEqual({
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        to: 'user:ou_5eea60f692ffd74100610029529c1369',
        accountId: 'default',
        bestEffort: false,
      },
      sessionKey: 'agent:main:feishu:direct:ou_5eea60f692ffd74100610029529c1369',
    });
  });
});
