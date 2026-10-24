import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executePingCommand } from '../application/ping.js';
import { t, type Locale } from '../../../locales/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { chatInteraction, embedAt, payloadAt } from './general.helpers.js';

/**
 * `/general ping` defers, then reports two figures: how long Discord took to
 * acknowledge the interaction (round trip) and the gateway heartbeat (API).
 * Time is frozen so the fallback to "now" is observable.
 */

const resolveLocale = vi.hoisted(() => vi.fn());
vi.mock('../../../locales/guildLocale.js', () => ({ resolveLocale }));

const NOW = new Date('2026-05-01T12:00:00Z').getTime();

/** deferReply mock resolving like `deferReply({ withResponse: true })`. */
function deferredAt(createdTimestamp: number | undefined) {
  return vi.fn().mockResolvedValue({
    resource: { message: { createdTimestamp } },
  });
}

async function ping(options: Parameters<typeof chatInteraction>[0] = {}) {
  const stub = chatInteraction({ subcommand: 'ping', ...options });
  await executePingCommand(stub.interaction);
  return stub;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  resolveLocale.mockReturnValue('en');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/general ping', () => {
  it('defers publicly and asks Discord for the created message', async () => {
    const { deferReply, editReply, interaction } = await ping({
      deferReply: deferredAt(NOW),
    });

    expect(resolveLocale).toHaveBeenCalledWith(interaction);
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(deferReply).toHaveBeenCalledWith({ withResponse: true });
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      editReply.mock.invocationCallOrder[0]
    );
  });

  it('reports round-trip and gateway latency', async () => {
    const { editReply } = await ping({
      createdTimestamp: NOW - 150,
      deferReply: deferredAt(NOW - 30),
      wsPing: 42,
    });

    expect(embedAt(editReply)).toEqual({
      title: t('ping.title', 'en'),
      color: COLORS.PRIMARY,
      fields: [
        { name: t('ping.latency', 'en'), value: '120ms', inline: true },
        { name: t('ping.apiLatency', 'en'), value: '42ms', inline: true },
      ],
      timestamp: new Date(NOW).toISOString(),
    });
    expect(payloadAt(editReply).components).toBeUndefined();
  });

  it.each<Locale>(['en', 'ja'])('labels the figures in %s', async (locale) => {
    resolveLocale.mockReturnValue(locale);

    const { editReply } = await ping({ deferReply: deferredAt(NOW) });

    const embed = embedAt(editReply);
    expect(embed.title).toBe(t('ping.title', locale));
    expect(embed.fields?.map((f) => f.name)).toEqual([
      t('ping.latency', locale),
      t('ping.apiLatency', locale),
    ]);
  });

  it.each([
    ['no callback resource', vi.fn().mockResolvedValue({ resource: null })],
    ['no message', vi.fn().mockResolvedValue({ resource: { message: null } })],
    ['no timestamp', deferredAt(undefined)],
  ])(
    'measures against the current time when Discord returns %s',
    async (_label, deferReply) => {
      const { editReply } = await ping({
        createdTimestamp: NOW - 75,
        deferReply,
      });

      expect(embedAt(editReply).fields?.[0].value).toBe('75ms');
    }
  );

  it('reports 0ms when the acknowledgement is instantaneous', async () => {
    const { editReply } = await ping({
      createdTimestamp: NOW,
      deferReply: deferredAt(NOW),
      wsPing: 0,
    });

    expect(embedAt(editReply).fields?.map((f) => f.value)).toEqual([
      '0ms',
      '0ms',
    ]);
  });

  it('ignores the local clock when Discord returns the created message', async () => {
    // Local clock an hour behind Discord: both timestamps are Discord's own.
    vi.setSystemTime(NOW - 60 * 60 * 1000);

    const { editReply } = await ping({
      createdTimestamp: NOW - 150,
      deferReply: deferredAt(NOW - 30),
    });

    expect(embedAt(editReply).fields?.[0].value).toBe('120ms');
  });

  // Only the fallback reads the local clock, so a clock behind Discord's
  // yields a negative round trip. Not specified anywhere; characterized so a
  // change to it is deliberate.
  it('reports the raw, negative difference when the fallback clock lags Discord', async () => {
    const { editReply } = await ping({
      createdTimestamp: NOW + 40,
      deferReply: vi.fn().mockResolvedValue({ resource: null }),
    });

    expect(embedAt(editReply).fields?.[0].value).toBe('-40ms');
  });

  // discord.js reports -1 until the first heartbeat is acknowledged. The
  // command must still answer, and must not pass -1 off as a measurement.
  it('still replies before the first gateway heartbeat (ws ping -1)', async () => {
    const { editReply } = await ping({
      createdTimestamp: NOW - 10,
      deferReply: deferredAt(NOW),
      wsPing: -1,
    });

    expect(editReply).toHaveBeenCalledTimes(1);
    const fields = embedAt(editReply).fields ?? [];
    expect(fields).toHaveLength(2);
    expect(fields[0].value).toBe('10ms');
    expect(fields[1].name).toBe(t('ping.apiLatency', 'en'));
    // Whatever placeholder a fix picks, it must not read like a real figure
    // such as "1ms" or "0ms".
    expect(fields[1].value).not.toMatch(/^\d+ms$/);
  });

  // BUG (reported, ping.ts:31): the raw -1 is shown as "-1ms". Characterized
  // until fixed; replace with the chosen placeholder then.
  it('currently shows the raw -1 before the first heartbeat', async () => {
    const { editReply } = await ping({
      deferReply: deferredAt(NOW),
      wsPing: -1,
    });

    expect(embedAt(editReply).fields?.[1].value).toBe('-1ms');
  });

  it('propagates a failed defer without editing the reply', async () => {
    const deferReply = vi
      .fn()
      .mockRejectedValue(new Error('Unknown interaction'));
    const { interaction, editReply } = chatInteraction({ deferReply });

    await expect(executePingCommand(interaction)).rejects.toThrow(
      'Unknown interaction'
    );
    expect(editReply).not.toHaveBeenCalled();
  });

  it('propagates a failed edit to the caller', async () => {
    const editReply = vi.fn().mockRejectedValue(new Error('Unknown message'));
    const { interaction } = chatInteraction({
      deferReply: deferredAt(NOW),
      editReply,
    });

    await expect(executePingCommand(interaction)).rejects.toThrow(
      'Unknown message'
    );
  });
});
