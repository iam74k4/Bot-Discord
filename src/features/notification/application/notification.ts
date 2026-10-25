import {
  ChatInputCommandInteraction,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import {
  createEmbed,
  createErrorEmbed,
  createInfoEmbed,
} from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { t, type Locale, type TranslationKey } from '../../../locales/index.js';
import { resolveLocale } from '../../../locales/guildLocale.js';
import {
  notificationChannelRepository,
  type NotificationType,
} from '../repositories/notificationChannelRepository.js';
import { showNotificationPanel } from './panel.js';
import { checkNotificationChannel } from './channelCheck.js';
import { postLanguageLines } from './postLanguage.js';
import { audit } from '../../../infrastructure/audit/index.js';

/** What differs between the VC and the welcome notification commands. */
interface NotificationKind {
  type: NotificationType;
  auditKind: 'Voice' | 'Welcome';
  /** Command that turns it back on, suggested after a disable. */
  setCommand: string;
  keys: Record<
    | 'set'
    | 'setTitle'
    | 'nextStep'
    | 'removed'
    | 'removedTitle'
    | 'disabledHint'
    | 'alreadyDisabled'
    | 'label',
    TranslationKey
  >;
}

const VOICE: NotificationKind = {
  type: 'voice',
  auditKind: 'Voice',
  setCommand: 'notification voice set',
  keys: {
    set: 'notification.voice.set',
    setTitle: 'notification.voice.setTitle',
    nextStep: 'notification.voice.nextStep',
    removed: 'notification.voice.removed',
    removedTitle: 'notification.voice.removedTitle',
    disabledHint: 'notification.voice.disabledHint',
    alreadyDisabled: 'notification.voice.alreadyDisabled',
    label: 'notification.summary.voice',
  },
};

const WELCOME: NotificationKind = {
  type: 'member_join',
  auditKind: 'Welcome',
  setCommand: 'notification welcome set',
  keys: {
    set: 'notification.welcome.set',
    setTitle: 'notification.welcome.setTitle',
    nextStep: 'notification.welcome.nextStep',
    removed: 'notification.welcome.removed',
    removedTitle: 'notification.welcome.removedTitle',
    disabledHint: 'notification.welcome.disabledHint',
    alreadyDisabled: 'notification.welcome.alreadyDisabled',
    label: 'notification.summary.welcome',
  },
};

async function replyError(
  interaction: ChatInputCommandInteraction,
  locale: Locale,
  message: string
): Promise<void> {
  await interaction.reply({
    embeds: [createErrorEmbed(t('common.error', locale), message)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSet(
  interaction: ChatInputCommandInteraction,
  kind: NotificationKind
): Promise<void> {
  const locale = resolveLocale(interaction);

  if (!interaction.guild || !interaction.guildId) {
    await replyError(interaction, locale, t('common.guildOnly', locale));
    return;
  }

  const channel = interaction.options.getChannel('channel', true);

  if (channel.type !== ChannelType.GuildText) {
    await replyError(
      interaction,
      locale,
      t('notification.errors.textChannelOnly', locale)
    );
    return;
  }

  const check = await checkNotificationChannel(
    interaction.guild,
    channel.id,
    locale
  );
  if (!check.ok) {
    await replyError(interaction, locale, check.message);
    return;
  }

  notificationChannelRepository.set(interaction.guildId, kind.type, channel.id);
  void audit.notifySetup(
    interaction.client,
    interaction.guildId,
    interaction.user.id,
    channel.id,
    kind.auditKind
  );

  const description = [
    t(kind.keys.set, locale, { channel: channel.id }),
    ...postLanguageLines(interaction.guild, locale),
    '',
    t(kind.keys.nextStep, locale, {
      command: commandMention('notification status'),
    }),
  ].join('\n');

  await interaction.reply({
    embeds: [
      createEmbed({
        title: t(kind.keys.setTitle, locale),
        description,
        color: COLORS.SUCCESS,
      }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRemove(
  interaction: ChatInputCommandInteraction,
  kind: NotificationKind
): Promise<void> {
  const locale = resolveLocale(interaction);

  if (!interaction.guildId) {
    await replyError(interaction, locale, t('common.guildOnly', locale));
    return;
  }

  const removed = notificationChannelRepository.remove(
    interaction.guildId,
    kind.type
  );

  if (!removed) {
    // Already off is a no-op, not a failure: say so and name the way back.
    await interaction.reply({
      embeds: [
        createInfoEmbed(
          t(kind.keys.label, locale),
          t(kind.keys.alreadyDisabled, locale, {
            command: commandMention(kind.setCommand),
          })
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  void audit.notifyRemove(
    interaction.client,
    interaction.guildId,
    interaction.user.id,
    kind.auditKind
  );

  await interaction.reply({
    embeds: [
      createEmbed({
        title: t(kind.keys.removedTitle, locale),
        description: `${t(kind.keys.removed, locale)}\n\n${t(
          kind.keys.disabledHint,
          locale,
          { command: commandMention(kind.setCommand) }
        )}`,
        color: COLORS.SUCCESS,
      }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleVoiceSet(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await handleSet(interaction, VOICE);
}

export async function handleVoiceRemove(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await handleRemove(interaction, VOICE);
}

export async function handleWelcomeSet(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await handleSet(interaction, WELCOME);
}

export async function handleWelcomeRemove(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await handleRemove(interaction, WELCOME);
}

export async function handleStatus(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  await showNotificationPanel(interaction, locale, { initialView: 'status' });
}
