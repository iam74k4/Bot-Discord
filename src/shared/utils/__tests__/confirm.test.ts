import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  InteractionType,
  MessageFlags,
  type ActionRowBuilder,
  type ButtonBuilder,
  type EmbedBuilder,
} from 'discord.js';
import { awaitConfirmation, awaitConfirmationResult } from '../confirm.js';
import { t } from '../../../locales/index.js';
import { COLORS } from '../constants/index.js';
import {
  clearLiveComponents,
  isLiveComponentMessage,
  isSettledComponentMessage,
  stopLiveComponents,
} from '../../interactions/liveComponents.js';
import { clearCommandIds, setCommandIds } from '../commandMentions.js';

/**
 * `awaitConfirmation` posts a Confirm/Cancel prompt and waits for the
 * invoking user to press one. The message's component collector is
 * simulated: it applies the real `filter` to a scripted sequence of button
 * presses and rejects after `time` ms like discord.js does, so timeouts are
 * driven by fake timers rather than waiting.
 */

const resolveLocale = vi.hoisted(() => vi.fn());
vi.mock('../../../locales/guildLocale.js', () => ({ resolveLocale }));

const OWNER = 'owner-1';
const INTERACTION_ID = 'int-42';
const CONFIRM_ID = `confirm_${INTERACTION_ID}`;
const CANCEL_ID = `cancel_${INTERACTION_ID}`;

const MESSAGE_ID = 'prompt-message-1';

interface Press {
  customId: string;
  user: { id: string };
  update: Mock;
  reply: Mock;
  deferUpdate: Mock;
}

function press(customId: string, userId = OWNER): Press {
  return {
    customId,
    user: { id: userId },
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  };
}

interface CollectorOptions {
  componentType: ComponentType;
  time: number;
  filter: (i: Press) => boolean | Promise<boolean>;
}

/**
 * A stand-in for `Message#awaitMessageComponent`: runs the (possibly async)
 * filter over each scripted press in order, like discord.js does.
 */
function collector(presses: Press[]) {
  return vi.fn(async (options: CollectorOptions) => {
    expect(isLiveComponentMessage(MESSAGE_ID)).toBe(true);
    for (const candidate of presses) {
      if (await options.filter(candidate)) return candidate;
    }
    return new Promise<Press>((_resolve, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              'Collector received no interactions before ending with reason: time'
            )
          ),
        options.time
      );
    });
  });
}

/**
 * Like `collector`, but every press arrives at once, as with a double click:
 * discord.js runs the filter for each before the collector can end, and the
 * first press the filter accepts is the one collected.
 */
function simultaneousCollector(presses: Press[]) {
  return vi.fn(async (options: CollectorOptions) => {
    const accepted = await Promise.all(presses.map((p) => options.filter(p)));
    const first = accepted.indexOf(true);
    if (first === -1) throw new Error('no press accepted');
    return presses[first];
  });
}

function prompt(
  options: {
    presses?: Press[];
    reply?: Mock;
    editReply?: Mock;
    awaitMessageComponent?: Mock;
  } = {}
) {
  const awaitMessageComponent =
    options.awaitMessageComponent ?? collector(options.presses ?? []);
  const reply =
    options.reply ??
    vi.fn().mockResolvedValue({
      resource: { message: { id: MESSAGE_ID, awaitMessageComponent } },
    });
  const editReply = options.editReply ?? vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id: INTERACTION_ID,
    commandName: 'community',
    options: {
      getSubcommandGroup: () => 'poll',
      getSubcommand: () => 'end',
    },
    user: { id: OWNER },
    guildId: 'guild-1',
    locale: 'en-US',
    reply,
    editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply, editReply, awaitMessageComponent };
}

type Row = ActionRowBuilder<ButtonBuilder>;

function buttonsOf(payload: { components: Row[] }) {
  expect(payload.components).toHaveLength(1);
  return payload.components[0].toJSON().components as {
    custom_id: string;
    label?: string;
    style: ButtonStyle;
    disabled?: boolean;
  }[];
}

function expectAllDisabled(mock: Mock) {
  expect(mock).toHaveBeenCalledTimes(1);
  const buttons = buttonsOf(mock.mock.calls[0][0]);
  expect(buttons.map((b) => b.custom_id)).toEqual([CONFIRM_ID, CANCEL_ID]);
  expect(buttons.every((b) => b.disabled === true)).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resolveLocale.mockReturnValue('en');
});

afterEach(() => {
  vi.useRealTimers();
  clearLiveComponents();
  clearCommandIds();
});

describe('awaitConfirmation', () => {
  describe('the prompt', () => {
    it('shows a warning embed with Confirm (danger) and Cancel buttons, ephemerally', async () => {
      const { interaction, reply } = prompt({ presses: [press(CANCEL_ID)] });

      await awaitConfirmation(interaction, 'Delete all recordings?');

      expect(reply).toHaveBeenCalledTimes(1);
      const payload = reply.mock.calls[0][0];
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(payload.withResponse).toBe(true);
      expect(payload.embeds).toHaveLength(1);
      expect((payload.embeds[0] as EmbedBuilder).toJSON()).toMatchObject({
        title: t('common.confirmMessage', 'en'),
        description: 'Delete all recordings?',
        color: COLORS.WARNING,
      });
      expect(buttonsOf(payload)).toEqual([
        expect.objectContaining({
          custom_id: CONFIRM_ID,
          label: t('common.confirm', 'en'),
          style: ButtonStyle.Danger,
        }),
        expect.objectContaining({
          custom_id: CANCEL_ID,
          label: t('common.cancel', 'en'),
          style: ButtonStyle.Secondary,
        }),
      ]);
      expect(buttonsOf(payload).some((b) => b.disabled)).toBe(false);
    });

    it('posts publicly when ephemeral is turned off', async () => {
      const { interaction, reply } = prompt({ presses: [press(CANCEL_ID)] });

      await awaitConfirmation(interaction, 'Proceed?', { ephemeral: false });

      expect(reply.mock.calls[0][0].flags).toBeUndefined();
    });

    it('labels everything in the resolved locale', async () => {
      resolveLocale.mockReturnValue('ja');
      const { interaction, reply } = prompt({ presses: [press(CANCEL_ID)] });

      await awaitConfirmation(interaction, '本当に？');

      expect(resolveLocale).toHaveBeenCalledWith(interaction);
      const payload = reply.mock.calls[0][0];
      expect((payload.embeds[0] as EmbedBuilder).toJSON().title).toBe(
        t('common.confirmMessage', 'ja')
      );
      expect(buttonsOf(payload).map((b) => b.label)).toEqual([
        t('common.confirm', 'ja'),
        t('common.cancel', 'ja'),
      ]);
    });

    it('waits for a button press for 30 seconds by default', async () => {
      const { interaction, awaitMessageComponent } = prompt({
        presses: [press(CANCEL_ID)],
      });

      await awaitConfirmation(interaction, 'Proceed?');

      expect(awaitMessageComponent).toHaveBeenCalledWith(
        expect.objectContaining({
          componentType: ComponentType.Button,
          time: 30_000,
        })
      );
    });

    it('honours a custom timeout', async () => {
      const { interaction, awaitMessageComponent } = prompt({
        presses: [press(CANCEL_ID)],
      });

      await awaitConfirmation(interaction, 'Proceed?', { timeout: 5_000 });

      expect(awaitMessageComponent).toHaveBeenCalledWith(
        expect.objectContaining({ time: 5_000 })
      );
    });
  });

  describe('outcomes', () => {
    it('resolves true when the user confirms, and disables the buttons', async () => {
      const confirm = press(CONFIRM_ID);
      const { interaction, editReply } = prompt({ presses: [confirm] });

      await expect(awaitConfirmation(interaction, 'Proceed?')).resolves.toBe(
        true
      );

      expectAllDisabled(confirm.update);
      expect(editReply).not.toHaveBeenCalled();
    });

    it('resolves false when the user cancels, and disables the buttons', async () => {
      const cancel = press(CANCEL_ID);
      const { interaction, editReply } = prompt({ presses: [cancel] });

      await expect(awaitConfirmation(interaction, 'Proceed?')).resolves.toBe(
        false
      );

      expectAllDisabled(cancel.update);
      expect(editReply).not.toHaveBeenCalled();
    });

    it('ignores presses from anyone other than the invoking user, telling them so', async () => {
      const intruder = press(CONFIRM_ID, 'someone-else');
      const ownerCancel = press(CANCEL_ID);
      const { interaction } = prompt({ presses: [intruder, ownerCancel] });

      await expect(awaitConfirmation(interaction, 'Proceed?')).resolves.toBe(
        false
      );

      expect(intruder.update).not.toHaveBeenCalled();
      expect(intruder.reply).toHaveBeenCalledWith({
        content: t('common.onlyCommandUser', 'en', {
          user: `<@${OWNER}>`,
          command: '`/community poll end`',
        }),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      expect(ownerCancel.update).toHaveBeenCalledTimes(1);
    });

    it('still ignores the intruder when telling them off fails', async () => {
      const intruder = press(CONFIRM_ID, 'someone-else');
      intruder.reply.mockRejectedValue(new Error('Unknown interaction'));
      const ownerCancel = press(CANCEL_ID);
      const { interaction } = prompt({ presses: [intruder, ownerCancel] });

      await expect(awaitConfirmation(interaction, 'Proceed?')).resolves.toBe(
        false
      );
      expect(ownerCancel.update).toHaveBeenCalledTimes(1);
    });

    it('leaves the prompt to its own collector only while waiting', async () => {
      const { interaction } = prompt({ presses: [press(CANCEL_ID)] });

      await awaitConfirmation(interaction, 'Proceed?');

      // The collector stand-in asserted the message was live while it ran.
      expect(isLiveComponentMessage(MESSAGE_ID)).toBe(false);
      // ...and a late second click is now acknowledged quietly by the router.
      expect(isSettledComponentMessage(MESSAGE_ID)).toBe(true);
    });

    it('resolves false and disables the buttons when shutdown closes the prompt', async () => {
      const { interaction, editReply } = prompt();

      const result = awaitConfirmation(interaction, 'Proceed?');
      await vi.advanceTimersByTimeAsync(0);
      await stopLiveComponents({ timeoutMs: 1_000 });

      await expect(result).resolves.toBe(false);
      expectAllDisabled(editReply);
    });

    it('times out (false) when only other users press, without acting on their press', async () => {
      const intruder = press(CONFIRM_ID, 'someone-else');
      const { interaction, editReply } = prompt({ presses: [intruder] });

      const result = awaitConfirmation(interaction, 'Proceed?');
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(result).resolves.toBe(false);
      expect(intruder.update).not.toHaveBeenCalled();
      expectAllDisabled(editReply);
    });

    it('resolves false only once the timeout elapses, then disables the buttons', async () => {
      const { interaction, editReply } = prompt();
      let settled = false;

      const result = awaitConfirmation(interaction, 'Proceed?').then(
        (value) => {
          settled = true;
          return value;
        }
      );

      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      expect(editReply).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(false);
      expectAllDisabled(editReply);
    });

    it('still resolves false when disabling the buttons after a timeout fails', async () => {
      const { interaction, editReply } = prompt({
        editReply: vi.fn().mockRejectedValue(new Error('Unknown Message')),
      });

      const result = awaitConfirmation(interaction, 'Proceed?', {
        timeout: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(false);
      expect(editReply).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the confirmed press cannot be acknowledged', async () => {
      const confirm = press(CONFIRM_ID);
      confirm.update.mockRejectedValue(new Error('Interaction expired'));
      const { interaction, editReply } = prompt({ presses: [confirm] });

      await expect(awaitConfirmation(interaction, 'Proceed?')).resolves.toBe(
        false
      );

      expectAllDisabled(editReply);
    });

    it('resolves false and disables the buttons when Discord returns no message', async () => {
      const { interaction, editReply } = prompt({
        reply: vi.fn().mockResolvedValue({ resource: null }),
      });

      await expect(awaitConfirmation(interaction, 'Proceed?')).resolves.toBe(
        false
      );

      expectAllDisabled(editReply);
    });

    it('propagates a failure to post the prompt', async () => {
      const failure = new Error('Interaction has already been acknowledged.');
      const { interaction, editReply } = prompt({
        reply: vi.fn().mockRejectedValue(failure),
      });

      await expect(awaitConfirmation(interaction, 'Proceed?')).rejects.toBe(
        failure
      );
      expect(editReply).not.toHaveBeenCalled();
    });
  });
});

describe('awaitConfirmationResult', () => {
  it("says what will happen, with the caller's own button labels and style", async () => {
    const { interaction, reply } = prompt({ presses: [press(CANCEL_ID)] });

    await awaitConfirmationResult(interaction, '**Best snack?**', {
      title: 'End this poll?',
      confirmLabel: 'End poll',
      confirmEmoji: '🛑',
      cancelLabel: 'Keep open',
      confirmStyle: ButtonStyle.Primary,
    });

    const payload = reply.mock.calls[0][0];
    expect((payload.embeds[0] as EmbedBuilder).toJSON()).toMatchObject({
      title: 'End this poll?',
      description: '**Best snack?**',
    });
    expect(buttonsOf(payload)).toEqual([
      expect.objectContaining({
        custom_id: CONFIRM_ID,
        label: 'End poll',
        style: ButtonStyle.Primary,
        emoji: expect.objectContaining({ name: '🛑' }),
      }),
      expect.objectContaining({
        custom_id: CANCEL_ID,
        label: 'Keep open',
        style: ButtonStyle.Secondary,
      }),
    ]);
  });

  it('hands back an unanswered press on confirm, so the caller acknowledges it once', async () => {
    const confirm = press(CONFIRM_ID);
    const { interaction, editReply } = prompt({ presses: [confirm] });

    const result = await awaitConfirmationResult(interaction, 'Proceed?');

    expect(result).toEqual({ outcome: 'confirmed', response: confirm });
    // No extra round trip: neither the press nor the prompt was touched.
    expect(confirm.update).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it('answers a cancel itself with a single update', async () => {
    const cancel = press(CANCEL_ID);
    const { interaction, editReply } = prompt({ presses: [cancel] });

    await expect(
      awaitConfirmationResult(interaction, 'Proceed?')
    ).resolves.toEqual({ outcome: 'cancelled' });

    expect(cancel.update).toHaveBeenCalledTimes(1);
    const payload = cancel.update.mock.calls[0][0];
    expect(payload.components).toEqual([]);
    expect(payload.embeds[0].toJSON()).toMatchObject({
      title: t('common.cancelled', 'en'),
      color: COLORS.INFO,
    });
    expect(editReply).not.toHaveBeenCalled();
  });

  it('reports a timeout as a timeout, not a cancel, and suggests running the command again', async () => {
    setCommandIds([{ name: 'community', id: '77' }]);
    resolveLocale.mockReturnValue('ja');
    const { interaction, editReply } = prompt();

    const result = awaitConfirmationResult(interaction, 'Proceed?', {
      timeout: 45_000,
    });
    await vi.advanceTimersByTimeAsync(45_000);

    await expect(result).resolves.toEqual({ outcome: 'timeout' });
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0][0];
    expect(payload.components).toEqual([]);
    expect(payload.embeds[0].toJSON()).toMatchObject({
      title: t('common.timedOutTitle', 'ja'),
      description: t('common.confirmTimedOutRetry', 'ja', {
        seconds: 45,
        command: '</community poll end:77>',
      }),
      color: COLORS.INFO,
    });
    expect(payload.embeds[0].toJSON().title).not.toBe(
      t('common.cancelled', 'ja')
    );
  });

  it('uses a caller-supplied retry command', async () => {
    const { interaction, editReply } = prompt();

    const result = awaitConfirmationResult(interaction, 'Proceed?', {
      timeout: 1_000,
      retryCommand: 'owner backup run',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    expect(editReply.mock.calls[0][0].embeds[0].toJSON().description).toContain(
      '`/owner backup run`'
    );
  });

  it('omits the retry hint when no command is known (a prompt from a button)', async () => {
    const { interaction, editReply } = prompt();
    const fromButton = {
      ...interaction,
      commandName: undefined,
      message: { interaction: null },
    } as unknown as ChatInputCommandInteraction;
    delete (fromButton as { commandName?: string }).commandName;

    const result = awaitConfirmationResult(fromButton, 'Proceed?', {
      timeout: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    expect(editReply.mock.calls[0][0].embeds[0].toJSON().description).toBe(
      t('common.confirmTimedOut', 'en', { seconds: 1 })
    );
  });

  it('reports a timeout when Discord returns no message to wait on', async () => {
    const { interaction } = prompt({
      reply: vi.fn().mockResolvedValue({ resource: null }),
    });

    await expect(
      awaitConfirmationResult(interaction, 'Proceed?')
    ).resolves.toEqual({ outcome: 'timeout' });
  });

  it('still resolves when the cancel or timeout notice cannot be shown', async () => {
    const cancel = press(CANCEL_ID);
    cancel.update.mockRejectedValue(new Error('Unknown interaction'));
    const cancelled = prompt({ presses: [cancel] });

    await expect(
      awaitConfirmationResult(cancelled.interaction, 'Proceed?')
    ).resolves.toEqual({ outcome: 'cancelled' });

    const timedOut = prompt({
      editReply: vi.fn().mockRejectedValue(new Error('Unknown Message')),
    });
    const result = awaitConfirmationResult(timedOut.interaction, 'Proceed?', {
      timeout: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toEqual({ outcome: 'timeout' });
  });

  describe('when the bot shuts down while it waits', () => {
    it('closes the prompt, says nothing was done, and reports no confirmation', async () => {
      setCommandIds([{ name: 'community', id: '77' }]);
      const { interaction, editReply } = prompt();

      const result = awaitConfirmationResult(interaction, 'Proceed?');
      await vi.advanceTimersByTimeAsync(0);
      expect(isLiveComponentMessage(MESSAGE_ID)).toBe(true);

      await stopLiveComponents({ timeoutMs: 1_000 });

      await expect(result).resolves.toEqual({ outcome: 'timeout' });
      expect(editReply).toHaveBeenCalledTimes(1);
      const payload = editReply.mock.calls[0][0];
      expect(payload.components).toEqual([]);
      expect(payload.embeds[0].toJSON()).toMatchObject({
        title: t('common.promptClosedTitle', 'en'),
        description: t('common.confirmInterruptedRetry', 'en', {
          command: '</community poll end:77>',
        }),
      });
    });

    it('makes shutdown wait until the prompt shows it has closed', async () => {
      let finishEdit!: () => void;
      const editReply = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishEdit = resolve;
          })
      );
      const { interaction } = prompt({ editReply });
      void awaitConfirmationResult(interaction, 'Proceed?');
      await vi.advanceTimersByTimeAsync(0);

      let stopped = false;
      const stopping = stopLiveComponents({ timeoutMs: 5_000 }).then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(editReply).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(false);

      finishEdit();
      await stopping;
      expect(stopped).toBe(true);
    });

    it('acknowledges a press that lands just as the prompt closes, and runs nothing', async () => {
      const confirm = press(CONFIRM_ID);
      let deliver!: () => void;
      const awaitMessageComponent = vi.fn(
        async (options: CollectorOptions) =>
          new Promise<Press>((resolve) => {
            deliver = async () => {
              if (await options.filter(confirm)) resolve(confirm);
            };
          })
      );
      const { interaction, editReply } = prompt({ awaitMessageComponent });

      const result = awaitConfirmationResult(interaction, 'Proceed?');
      await vi.advanceTimersByTimeAsync(0);
      await stopLiveComponents({ timeoutMs: 1_000 });
      deliver();
      await vi.advanceTimersByTimeAsync(0);

      await expect(result).resolves.toEqual({ outcome: 'timeout' });
      expect(editReply).toHaveBeenCalledTimes(1);
      // Closed: the filter turns the press away, so the router answers it.
      expect(confirm.deferUpdate).not.toHaveBeenCalled();
      expect(confirm.update).not.toHaveBeenCalled();
    });

    it('acknowledges a press the collector accepted just before the prompt closed', async () => {
      const confirm = press(CONFIRM_ID);
      let collect!: () => void;
      const awaitMessageComponent = vi.fn(async (options: CollectorOptions) => {
        await options.filter(confirm); // accepted...
        // ...but handed over only after shutdown closed the prompt.
        return new Promise<Press>((resolve) => {
          collect = () => resolve(confirm);
        });
      });
      const { interaction } = prompt({ awaitMessageComponent });

      const result = awaitConfirmationResult(interaction, 'Proceed?');
      await vi.advanceTimersByTimeAsync(0);
      await stopLiveComponents({ timeoutMs: 1_000 });
      collect();
      await vi.advanceTimersByTimeAsync(0);

      await expect(result).resolves.toEqual({ outcome: 'timeout' });
      expect(confirm.deferUpdate).toHaveBeenCalledTimes(1);
      expect(confirm.update).not.toHaveBeenCalled();
    });

    it('says so without a retry hint when no command is known', async () => {
      const { interaction, editReply } = prompt();
      const fromButton = {
        ...interaction,
        message: { interaction: null },
      } as unknown as ChatInputCommandInteraction;
      delete (fromButton as { commandName?: string }).commandName;

      const result = awaitConfirmationResult(fromButton, 'Proceed?');
      await vi.advanceTimersByTimeAsync(0);
      await stopLiveComponents({ timeoutMs: 1_000 });
      await result;

      expect(editReply.mock.calls[0][0].embeds[0].toJSON().description).toBe(
        t('common.confirmInterrupted', 'en')
      );
    });
  });

  it('lets the first of two quick presses decide and quietly acknowledges the second', async () => {
    const confirm = press(CONFIRM_ID);
    const cancel = press(CANCEL_ID);
    const { interaction } = prompt({
      awaitMessageComponent: simultaneousCollector([confirm, cancel]),
    });

    const result = await awaitConfirmationResult(interaction, 'Proceed?');

    expect(result).toEqual({ outcome: 'confirmed', response: confirm });
    expect(cancel.deferUpdate).toHaveBeenCalledTimes(1);
    expect(cancel.update).not.toHaveBeenCalled();
    expect(cancel.reply).not.toHaveBeenCalled();
    // The confirm is still the caller's to answer.
    expect(confirm.update).not.toHaveBeenCalled();
    expect(confirm.deferUpdate).not.toHaveBeenCalled();
  });

  describe('a prompt opened from a panel button', () => {
    function fromButton(origin: unknown) {
      const { interaction, editReply } = prompt();
      const pressed = {
        ...interaction,
        message: { interaction: origin },
      } as unknown as ChatInputCommandInteraction;
      delete (pressed as { commandName?: string }).commandName;
      return { interaction: pressed, editReply };
    }

    it('suggests the command that opened the panel', async () => {
      const { interaction, editReply } = fromButton({
        type: InteractionType.ApplicationCommand,
        commandName: 'admin settings view',
      });

      const result = awaitConfirmationResult(interaction, 'Proceed?', {
        timeout: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await result;

      expect(
        editReply.mock.calls[0][0].embeds[0].toJSON().description
      ).toContain('`/admin settings view`');
    });

    it('does not mistake a button customId for a command', async () => {
      // The panel message itself answered a button press.
      const { interaction, editReply } = fromButton({
        type: InteractionType.MessageComponent,
        commandName: 'admin-panel:backup',
      });

      const result = awaitConfirmationResult(interaction, 'Proceed?', {
        timeout: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await result;

      expect(editReply.mock.calls[0][0].embeds[0].toJSON().description).toBe(
        t('common.confirmTimedOut', 'en', { seconds: 1 })
      );
    });

    it('turns other users away without pointing at a command', async () => {
      const intruder = press(CONFIRM_ID, 'someone-else');
      const ownerCancel = press(CANCEL_ID);
      const { interaction } = prompt({ presses: [intruder, ownerCancel] });
      const pressed = {
        ...interaction,
        message: { interaction: null },
      } as unknown as ChatInputCommandInteraction;
      delete (pressed as { commandName?: string }).commandName;

      await awaitConfirmationResult(pressed, 'Proceed?');

      expect(intruder.reply).toHaveBeenCalledWith({
        content: t('common.onlyCommandUserGeneric', 'en', {
          user: `<@${OWNER}>`,
        }),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    });
  });
});
