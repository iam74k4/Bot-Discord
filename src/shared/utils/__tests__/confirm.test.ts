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
  MessageFlags,
  type ActionRowBuilder,
  type ButtonBuilder,
  type EmbedBuilder,
} from 'discord.js';
import { awaitConfirmation } from '../confirm.js';
import { t } from '../../../locales/index.js';
import { COLORS } from '../constants/index.js';

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

interface Press {
  customId: string;
  user: { id: string };
  update: Mock;
}

function press(customId: string, userId = OWNER): Press {
  return {
    customId,
    user: { id: userId },
    update: vi.fn().mockResolvedValue(undefined),
  };
}

interface CollectorOptions {
  componentType: ComponentType;
  time: number;
  filter: (i: Press) => boolean;
}

/** A stand-in for `Message#awaitMessageComponent`. */
function collector(presses: Press[]) {
  return vi.fn(
    (options: CollectorOptions) =>
      new Promise<Press>((resolve, reject) => {
        const accepted = presses.find((p) => options.filter(p));
        if (accepted) {
          resolve(accepted);
          return;
        }
        setTimeout(
          () =>
            reject(
              new Error(
                'Collector received no interactions before ending with reason: time'
              )
            ),
          options.time
        );
      })
  );
}

function prompt(
  options: {
    presses?: Press[];
    reply?: Mock;
    editReply?: Mock;
  } = {}
) {
  const awaitMessageComponent = collector(options.presses ?? []);
  const reply =
    options.reply ??
    vi.fn().mockResolvedValue({
      resource: { message: { awaitMessageComponent } },
    });
  const editReply = options.editReply ?? vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id: INTERACTION_ID,
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

    it('ignores presses from anyone other than the invoking user', async () => {
      const intruder = press(CONFIRM_ID, 'someone-else');
      const ownerCancel = press(CANCEL_ID);
      const { interaction } = prompt({ presses: [intruder, ownerCancel] });

      await expect(awaitConfirmation(interaction, 'Proceed?')).resolves.toBe(
        false
      );

      expect(intruder.update).not.toHaveBeenCalled();
      expect(ownerCancel.update).toHaveBeenCalledTimes(1);
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
