import {
  type EmbedBuilder,
  type Guild,
  PermissionFlagsBits,
  type PermissionsString,
} from 'discord.js';
import { env } from '../../../config/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { permissionNames } from '../../../shared/utils/discord.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { t, type Locale, type TranslationKey } from '../../../locales/index.js';
import { resolveBackgroundLocale } from '../../../locales/guildLocale.js';

/**
 * Permissions the features rely on, in the order they are explained. Most
 * are inherited from @everyone, so the "missing" list is usually empty.
 */
const NEEDED_PERMISSIONS = [
  'ViewChannel',
  'Connect',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
  'ManageRoles',
] as const satisfies readonly PermissionsString[];

/** The bot needs these to post the welcome into the system channel. */
const POST_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

function missingPermissionLines(guild: Guild, locale: Locale): string[] {
  const me = guild.members.me;
  if (!me) return [];
  return me.permissions.missing([...NEEDED_PERMISSIONS]).map((flag) =>
    t('onboarding.missingLine', locale, {
      permission: permissionNames(PermissionFlagsBits[flag], locale)[0] ?? flag,
      effect: t(`onboarding.missing.${flag}` as TranslationKey, locale, {
        command: commandMention('admin role add'),
      }),
    })
  );
}

/**
 * The first-run message: what the bot does, that it starts keeping voice
 * audio on its own (and how to stop that), the first settings to make, and
 * which permissions it lacks.
 */
export function buildOnboardingEmbed(
  guild: Guild,
  locale: Locale
): EmbedBuilder {
  const fields = [
    {
      name: t('onboarding.bufferingTitle', locale),
      value: t('onboarding.buffering', locale, {
        minutes: Math.round(env.AUDIO_BUFFER_DURATION / 60),
        record: commandMention('voice record'),
        disable: commandMention('voice autojoin disable'),
        exclude: commandMention('voice autojoin exclude'),
      }),
    },
    {
      name: t('onboarding.setupTitle', locale),
      value: t('onboarding.setup', locale, {
        language: commandMention('admin settings language'),
        voice: commandMention('notification voice set'),
        welcome: commandMention('notification welcome set'),
        audit: commandMention('admin settings audit'),
        announcements: commandMention('admin settings announcements'),
      }),
    },
  ];

  const missing = missingPermissionLines(guild, locale);
  if (missing.length > 0) {
    fields.push({
      name: t('onboarding.missingTitle', locale),
      value: missing.join('\n'),
    });
  }

  return createEmbed({
    title: t('onboarding.title', locale),
    description: t('onboarding.description', locale, {
      help: commandMention('general help'),
    }),
    color: COLORS.PRIMARY,
    fields,
    footer: t('onboarding.footer', locale),
  });
}

/**
 * Greet a server that just added the bot. Posted in the system channel when
 * the bot may write there, otherwise sent to the owner by DM; nothing is
 * posted into arbitrary channels. Best effort: failing to greet must not
 * stop the bot from working in the new server.
 */
export async function welcomeNewGuild(guild: Guild): Promise<void> {
  try {
    const locale = resolveBackgroundLocale(guild);
    const embed = buildOnboardingEmbed(guild, locale);
    const me = guild.members.me;
    const systemChannel = guild.systemChannel;

    if (
      systemChannel &&
      me &&
      systemChannel.permissionsFor(me)?.has(POST_PERMISSIONS)
    ) {
      await systemChannel.send({ embeds: [embed] });
      return;
    }

    const owner = await guild.fetchOwner();
    await owner.send({ embeds: [embed] });
  } catch (error) {
    logger.warn(
      `Could not send the welcome message for guild ${guild.id}: ${getErrorMessage(error)}`
    );
  }
}
