import { ChatInputCommandInteraction } from 'discord.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { env } from '../../../config/index.js';
import { t, type Locale } from '../../../locales/index.js';
import { formatDuration } from '../../../locales/format.js';
import {
  getGuildLanguage,
  resolveLocale,
} from '../../../locales/guildLocale.js';
import { guildSettingsRepository } from '../../../infrastructure/guildSettings/index.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import type { ExtendedClient } from '../../../client.js';
import { getHelpIndex } from './helpIndex.js';
import {
  canUserSeeCommandWithContext,
  getPermissionContext,
} from './visibility.js';
import { HELP_COMMAND_PATH } from './help.js';

/**
 * Commands most members reach for first, in the order they are shown. Only
 * the ones this build loaded and the asker may run are listed.
 */
const POPULAR_PATHS = [
  HELP_COMMAND_PATH,
  'notification stats',
  'community poll create',
  'community roulette team',
  'tts start',
];

/** Language names are shown in their own language, whoever is reading. */
const LANGUAGE_NAMES: Record<Locale, string> = { ja: '日本語', en: 'English' };

const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

interface Field {
  name: string;
  value: string;
  inline: boolean;
}

function popularCommandsField(
  interaction: ChatInputCommandInteraction,
  locale: Locale
): Field | null {
  const index = getHelpIndex((interaction.client as ExtendedClient).commands);
  const ctx = getPermissionContext(interaction);
  const inDm = interaction.guildId === null;

  const lines = POPULAR_PATHS.flatMap((path) => {
    const found = index.byLeaf.get(path);
    if (!found || !canUserSeeCommandWithContext(found.indexed.entry, ctx)) {
      return [];
    }
    // A mention of a server-only command cannot be run from the bot DM.
    if (inDm && found.indexed.entry.guildOnly) return [];
    return [`${commandMention(path)} - ${found.leaf.description[locale]}`];
  });

  return lines.length > 0
    ? {
        name: t('about.popularTitle', locale),
        value: lines.join('\n'),
        inline: false,
      }
    : null;
}

/**
 * What the bot does with voice in this server: whether it is keeping audio
 * right now, for how long, and what happens to saved recordings. Members
 * are recorded by it, so they should be able to find this out themselves.
 */
function voiceField(guildId: string, locale: Locale): Field {
  // To the second: minute precision rounds down, and a disclosure must
  // never say less audio is kept than is (90 s is not "1 minute").
  const buffer = formatDuration(
    env.AUDIO_BUFFER_DURATION * MS_PER_SECOND,
    locale,
    { style: 'long', precision: 'seconds' }
  );
  const retention = formatDuration(
    env.RECORDING_RETENTION_HOURS * MS_PER_HOUR,
    locale,
    { style: 'long' }
  );

  const keeping = guildSettingsRepository.isVoiceAutoJoinEnabled(guildId)
    ? t('about.voiceOn', locale, {
        duration: buffer,
        disable: commandMention('voice autojoin disable'),
      })
    : t('about.voiceOff', locale, {
        enable: commandMention('voice autojoin enable'),
      });

  return {
    name: t('about.voiceTitle', locale),
    value: `${keeping}\n${t('about.recordings', locale, {
      record: commandMention('voice record'),
      retention,
    })}`,
    inline: false,
  };
}

function languageField(
  guildId: string | null,
  locale: Locale,
  commandsLoaded: boolean
): Field {
  const language = LANGUAGE_NAMES[locale];
  const fromGuild = getGuildLanguage(guildId) !== null;
  const lines = [
    fromGuild
      ? t('about.languageGuild', locale, { language })
      : t('about.languageAuto', locale, { language }),
  ];
  if (guildId && commandsLoaded) {
    lines.push(
      t('about.languageChange', locale, {
        command: commandMention('admin settings language'),
      })
    );
  }

  return {
    name: t('about.languageTitle', locale),
    value: lines.join('\n'),
    inline: false,
  };
}

/**
 * `/general about`: what the bot is for, written for members rather than
 * for whoever runs it - the commands to start with, how voice audio is
 * handled here, and why replies come in the language they do.
 */
export async function executeAboutCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const commands = (interaction.client as ExtendedClient).commands;

  const fields: Field[] = [];
  const popular = popularCommandsField(interaction, locale);
  if (popular) fields.push(popular);
  if (interaction.guildId && commands.has('voice')) {
    fields.push(voiceField(interaction.guildId, locale));
  }
  fields.push(
    languageField(interaction.guildId, locale, commands.has('admin'))
  );

  const embed = createEmbed({
    title: t('about.title', locale),
    description: t('about.description', locale, {
      help: commandMention(HELP_COMMAND_PATH),
    }),
    color: COLORS.INFO,
    fields,
  });

  await interaction.reply({ embeds: [embed] });
}
