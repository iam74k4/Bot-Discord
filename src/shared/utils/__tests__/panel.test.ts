import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => String(e),
}));

// Echo the key and its parameters so assertions can see both.
vi.mock('../../../locales/index.js', () => ({
  t: (key: string, _locale: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}));

const { runComponentPanel, PANEL_MAX_LIFETIME } = await import('../panel.js');
const { isLiveComponentMessage, stopLiveComponents, clearLiveComponents } =
  await import('../../interactions/liveComponents.js');
const { setCommandIds, clearCommandIds } =
  await import('../commandMentions.js');

type Listener = (...args: unknown[]) => Promise<void> | void;

const MESSAGE_ID = 'panel-message-1';

/** Captures the collector callbacks so tests can fire components by hand. */
function createHarness(options?: { withCollector?: boolean }) {
  const listeners = new Map<string, Listener>();
  const editReply = vi.fn().mockResolvedValue({});
  const stop = vi.fn();

  const collector = {
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
      return collector;
    },
    stop: (reason?: string) => {
      stop(reason);
      return listeners.get('end')?.(new Map(), reason ?? 'user');
    },
  };

  const message = {
    id: MESSAGE_ID,
    createMessageComponentCollector: vi.fn(() => collector),
  };

  // withResponse: true resolves to an InteractionCallbackResponse whose
  // resource carries the message; Discord may omit it.
  const response = {
    resource: options?.withCollector === false ? null : { message },
  };

  const interaction = {
    commandName: 'admin',
    options: {
      getSubcommandGroup: () => 'settings',
      getSubcommand: () => 'view',
    },
    user: { id: 'owner-1' },
    reply: vi.fn().mockResolvedValue(response),
    editReply,
  };

  return {
    interaction,
    message,
    editReply,
    stop,
    collect: (componentInteraction: unknown) =>
      listeners.get('collect')?.(componentInteraction),
    end: (reason = 'idle') => listeners.get('end')?.(new Map(), reason),
    hasListeners: () => listeners.size > 0,
  };
}

function componentFrom(userId = 'owner-1') {
  return {
    user: { id: userId },
    customId: 'panel:tab',
    replied: false,
    deferred: false,
    update: vi.fn().mockResolvedValue({}),
    reply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn().mockResolvedValue({}),
    deferUpdate: vi.fn().mockResolvedValue({}),
  };
}

function basePanel(
  harness: ReturnType<typeof createHarness>,
  overrides: Record<string, unknown> = {}
) {
  return {
    interaction: harness.interaction as never,
    locale: 'en' as const,
    label: 'test panel',
    render: () => ({ embeds: [], components: ['live'] }) as never,
    renderDisabled: () => ['disabled'] as never,
    onComponent: () => 'update' as const,
    ...overrides,
  };
}

describe('runComponentPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearLiveComponents();
    clearCommandIds();
  });

  it('replies ephemerally with the first render', async () => {
    const harness = createHarness();

    await runComponentPanel(
      basePanel(harness, {
        render: () => ({ embeds: ['first'], components: ['row'] }) as never,
      })
    );

    expect(harness.interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: ['first'],
        components: ['row'],
        flags: MessageFlags.Ephemeral,
        withResponse: true,
      })
    );
  });

  it('can reply publicly when a panel opts out of ephemeral', async () => {
    const harness = createHarness();

    await runComponentPanel(basePanel(harness, { ephemeral: false }));

    const payload = harness.interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBeUndefined();
  });

  describe('expiry timer', () => {
    it('closes after two idle minutes, restarted by every click, within the token lifetime', async () => {
      const harness = createHarness();

      await runComponentPanel(basePanel(harness));

      expect(
        harness.message.createMessageComponentCollector
      ).toHaveBeenCalledWith({ idle: 120_000, time: PANEL_MAX_LIFETIME });
      // Interaction tokens expire after 15 minutes; the closing edit needs one.
      expect(PANEL_MAX_LIFETIME).toBeLessThan(15 * 60_000);
    });

    it('uses a caller timeout as the idle time and keeps the component type', async () => {
      const harness = createHarness();

      await runComponentPanel(
        basePanel(harness, { timeout: 30_000, componentType: 3 })
      );

      expect(
        harness.message.createMessageComponentCollector
      ).toHaveBeenCalledWith({
        componentType: 3,
        idle: 30_000,
        time: PANEL_MAX_LIFETIME,
      });
    });
  });

  it('re-renders after a component is handled with "update"', async () => {
    const harness = createHarness();
    let view = 'a';

    await runComponentPanel(
      basePanel(harness, {
        render: () => ({ embeds: [view], components: [] }) as never,
        onComponent: () => {
          view = 'b';
          return 'update';
        },
      })
    );

    const component = componentFrom();
    await harness.collect(component);

    expect(component.update).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: ['b'] })
    );
  });

  it('leaves the message alone when the callback already responded', async () => {
    const harness = createHarness();

    await runComponentPanel(
      basePanel(harness, { onComponent: () => 'handled' })
    );

    const component = componentFrom();
    await harness.collect(component);

    expect(component.update).not.toHaveBeenCalled();
  });

  it('turns away anyone but the command runner, telling them how to get their own', async () => {
    const harness = createHarness();
    const onComponent = vi.fn().mockReturnValue('update');
    setCommandIds([{ name: 'admin', id: '55' }]);

    await runComponentPanel(basePanel(harness, { onComponent }));

    const intruder = componentFrom('someone-else');
    await harness.collect(intruder);

    expect(onComponent).not.toHaveBeenCalled();
    expect(intruder.reply).toHaveBeenCalledWith({
      content: `common.onlyCommandUser ${JSON.stringify({
        user: '<@owner-1>',
        command: '</admin settings view:55>',
      })}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  });

  describe('when the handler throws', () => {
    it('answers the click with a private notice carrying the logged error id', async () => {
      const harness = createHarness();

      await runComponentPanel(
        basePanel(harness, {
          onComponent: () => {
            throw new Error('boom');
          },
        })
      );

      const component = componentFrom();
      await harness.collect(component);

      // Without an answer the user sees "This interaction failed".
      expect(component.reply).toHaveBeenCalledTimes(1);
      const payload = component.reply.mock.calls[0][0];
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      const id = /"id":"([0-9a-f]{6})"/.exec(payload.content)?.[1];
      expect(payload.content).toContain('common.actionFailed');
      expect(id).toBeDefined();
      expect(logger.warn).toHaveBeenCalledWith(
        `[${id}] Failed to update test panel:`,
        expect.stringContaining('boom')
      );
      expect(component.update).not.toHaveBeenCalled();
    });

    it('follows up instead when the handler had already acknowledged the click', async () => {
      const harness = createHarness();
      const component = componentFrom();

      await runComponentPanel(
        basePanel(harness, {
          onComponent: () => {
            component.deferred = true;
            throw new Error('after defer');
          },
        })
      );
      await harness.collect(component);

      expect(component.reply).not.toHaveBeenCalled();
      expect(component.followUp).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('common.actionFailed'),
          flags: MessageFlags.Ephemeral,
        })
      );
    });

    it('survives a failed notice', async () => {
      const harness = createHarness();
      await runComponentPanel(
        basePanel(harness, {
          onComponent: () => {
            throw new Error('boom');
          },
        })
      );
      const component = componentFrom();
      component.reply.mockRejectedValue(new Error('Unknown interaction'));

      await expect(harness.collect(component)).resolves.toBeUndefined();
    });
  });

  describe('closing', () => {
    it('disables the components and explains how to reopen the panel', async () => {
      const harness = createHarness();

      await runComponentPanel(basePanel(harness));
      await harness.end('idle');

      expect(harness.editReply).toHaveBeenCalledWith({
        content: `common.panelExpired ${JSON.stringify({
          command: '`/admin settings view`',
        })}`,
        components: ['disabled'],
      });
    });

    it('closes in the language the panel has by then', async () => {
      const harness = createHarness();
      let current: 'en' | 'ja' = 'en';
      const locale = vi.fn(() => current);

      await runComponentPanel({ ...basePanel(harness), locale });
      // e.g. the settings panel's language tab switched it.
      current = 'ja';
      await harness.end('idle');

      expect(locale).toHaveBeenCalled();
      expect(locale.mock.results.every((r) => r.value === 'ja')).toBe(true);
    });

    it('suggests the caller-supplied command instead', async () => {
      const harness = createHarness();

      await runComponentPanel(
        basePanel(harness, { reopenCommand: 'admin settings logs' })
      );
      await harness.end('time');

      expect(harness.editReply.mock.calls[0][0].content).toContain(
        '/admin settings logs'
      );
    });

    it('falls back to generic wording when no command is known', async () => {
      const harness = createHarness();
      const interaction = { ...harness.interaction, commandName: '' };

      await runComponentPanel({
        ...basePanel(harness),
        interaction: interaction as never,
      });
      await harness.end('idle');

      expect(harness.editReply).toHaveBeenCalledWith({
        content: 'common.panelExpiredGeneric',
        components: ['disabled'],
      });
    });

    it('does not try to edit a message that was deleted', async () => {
      const harness = createHarness();

      await runComponentPanel(basePanel(harness));
      await harness.end('messageDelete');

      expect(harness.editReply).not.toHaveBeenCalled();
    });
  });

  describe('live tracking', () => {
    it('marks its message live until the collector ends', async () => {
      const harness = createHarness();

      await runComponentPanel(basePanel(harness));
      expect(isLiveComponentMessage(MESSAGE_ID)).toBe(true);

      await harness.end('idle');
      expect(isLiveComponentMessage(MESSAGE_ID)).toBe(false);
    });

    it('closes visibly when the bot shuts down', async () => {
      const harness = createHarness();
      await runComponentPanel(basePanel(harness));

      await stopLiveComponents({ timeoutMs: 1_000 });

      expect(harness.stop).toHaveBeenCalledWith('shutdown');
      expect(harness.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ components: ['disabled'] })
      );
      expect(isLiveComponentMessage(MESSAGE_ID)).toBe(false);
    });
  });

  it('returns quietly when Discord returns no message to collect on', async () => {
    const harness = createHarness({ withCollector: false });

    await runComponentPanel(basePanel(harness));

    expect(harness.hasListeners()).toBe(false);
    expect(isLiveComponentMessage(MESSAGE_ID)).toBe(false);
  });
});
