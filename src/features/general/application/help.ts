import {
  ActionRowBuilder,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageComponentInteraction,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { t, type Locale } from '../../../locales/index.js';
import { resolveLocale } from '../../../locales/guildLocale.js';
import type {
  CommandCategory,
  CommandInfo,
  HelpLeaf,
  HelpOption,
} from '../../../shared/help/catalog.js';
import type { ExtendedClient } from '../../../client.js';
import { runComponentPanel } from '../../../shared/utils/panel.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { releaseCooldown } from '../../../middleware/index.js';
import {
  canUserSeeCommandWithContext,
  formatCommandPermissionLabel,
  formatPermissionAlternatives,
  getPermissionContext,
} from './visibility.js';
import {
  closestEntry,
  getHelpIndex,
  MATCH_SCORE,
  searchEntries,
  type HelpIndex,
} from './helpIndex.js';

export {
  canUserSeeCommandWithContext,
  type PermissionContext,
} from './visibility.js';

/** Path that opens help, for mentions and the panel's "run it again". */
export const HELP_COMMAND_PATH = 'general help';

/** Discord limits that shape what help sends. */
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_CHOICE_NAME = 100;
const MAX_SELECT_OPTIONS = 25;
const MAX_SELECT_TEXT = 100;
const MAX_FIELDS = 25;
const MAX_FIELD_VALUE = 1024;
const MAX_DESCRIPTION = 4096;
const MAX_EMBED_TEXT = 6000;

/** Description preview length in an autocomplete suggestion. */
const SUGGESTION_PREVIEW = 60;
/** Options with more choices than this list only their description. */
const MAX_LISTED_CHOICES = 6;
/** How many entries a "several commands match" reply lists. */
const MAX_LISTED_MATCHES = 10;
/** How much of a typed query is echoed back. */
const MAX_QUERY_ECHO = 50;

const CATEGORY_SELECT_ID = 'help_category';
const COMMAND_SELECT_ID = 'help_command';
const BACK_BUTTON_ID = 'help_back';

type HelpInteraction = AutocompleteInteraction | ChatInputCommandInteraction;

interface Field {
  name: string;
  value: string;
  inline: boolean;
}

/** Reply flags for a private (ephemeral) or channel-visible answer. */
function privacyFlags(ephemeral: boolean) {
  return ephemeral ? ({ flags: MessageFlags.Ephemeral } as const) : {};
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? text.slice(0, max) : `${text.slice(0, max - 1)}…`;
}

function helpIndexOf(interaction: HelpInteraction): HelpIndex {
  return getHelpIndex((interaction.client as ExtendedClient).commands);
}

function visibilityOf(
  interaction: HelpInteraction
): (entry: CommandInfo) => boolean {
  const ctx = getPermissionContext(interaction);
  return (entry) => canUserSeeCommandWithContext(entry, ctx);
}

/** One runnable path, which Discord can render as a tappable mention. */
function isRunnable(entry: CommandInfo): boolean {
  const leaves = entry.leaves ?? [];
  return leaves.length === 1 && leaves[0].path === entry.name;
}

function pathReference(path: string, mentions: boolean): string {
  return mentions ? commandMention(path) : `\`/${path}\``;
}

/** A group cannot be mentioned, so it stays a plain path. */
function entryReference(entry: CommandInfo, mentions: boolean): string {
  return pathReference(entry.name, mentions && isRunnable(entry));
}

function entryLine(
  entry: CommandInfo,
  locale: Locale,
  mentions: boolean
): string {
  return `${entryReference(entry, mentions)} - ${entry.description[locale]}${formatCommandPermissionLabel(entry, locale)}`;
}

/**
 * Join whole lines within `max` characters. Lines that do not fit are
 * replaced by a final `…`, so a mention is never cut in half.
 */
function joinWithin(lines: string[], max: number): string {
  let text = '';
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > max) {
      if (!text) return shorten(line, max);
      return `${text}\n…`.length <= max ? `${text}\n…` : text;
    }
    text = next;
  }
  return text;
}

/** Entry lines with tappable mentions when they fit, plain paths otherwise. */
function renderEntryLines(
  entries: CommandInfo[],
  locale: Locale,
  max: number,
  mentions = true
): string {
  if (mentions) {
    const linked = entries.map((e) => entryLine(e, locale, true)).join('\n');
    if (linked.length <= max) return linked;
  }
  return joinWithin(
    entries.map((e) => entryLine(e, locale, false)),
    max
  );
}

function embedTextLength(parts: {
  title?: string;
  description?: string;
  footer?: string;
  fields?: Field[];
}): number {
  return (
    (parts.title?.length ?? 0) +
    (parts.description?.length ?? 0) +
    (parts.footer?.length ?? 0) +
    (parts.fields ?? []).reduce(
      (total, field) => total + field.name.length + field.value.length,
      0
    )
  );
}

// ---------------------------------------------------------------------------
// Embeds
// ---------------------------------------------------------------------------

function buildOverviewEmbed(
  categories: CommandCategory[],
  locale: Locale,
  withMenu: boolean
): EmbedBuilder {
  const title = t('help.title', locale);
  // Only point at "the menu below" when there is one.
  const description = t(
    withMenu ? 'help.description' : 'help.descriptionNoMenu',
    locale
  );
  const footer = t('help.filteredFooter', locale);
  const fieldsWith = (mentions: boolean): Field[] =>
    categories.map((category) => ({
      name: category.name[locale],
      value: renderEntryLines(
        category.commands,
        locale,
        MAX_FIELD_VALUE,
        mentions
      ),
      inline: false,
    }));

  // Mentions are about three times as long as a plain path; drop them
  // everywhere rather than overflow Discord's per-embed total.
  let fields = fieldsWith(true);
  if (
    embedTextLength({ title, description, footer, fields }) > MAX_EMBED_TEXT
  ) {
    fields = fieldsWith(false);
  }

  return createEmbed({
    title,
    description,
    color: COLORS.PRIMARY,
    fields,
    footer,
  });
}

function buildCategoryEmbed(
  category: CommandCategory,
  locale: Locale
): EmbedBuilder {
  return createEmbed({
    title: category.name[locale],
    description: renderEntryLines(category.commands, locale, MAX_DESCRIPTION),
    color: COLORS.PRIMARY,
    footer: t('help.filteredFooter', locale),
  });
}

function optionLine(option: HelpOption, locale: Locale): string {
  const choices =
    option.choices && option.choices.length <= MAX_LISTED_CHOICES
      ? t('help.optionChoices', locale, {
          choices: option.choices.map((choice) => choice[locale]).join(' / '),
        })
      : '';
  return t('help.optionLine', locale, {
    name: option.name[locale],
    required: option.required ? t('help.optionRequired', locale) : '',
    description: `${option.description[locale]}${choices}`,
  });
}

function leafBlock(
  leaf: HelpLeaf,
  locale: Locale,
  mentions: boolean,
  withOptions: boolean
): string {
  const lines = [pathReference(leaf.path, mentions)];
  if (withOptions) {
    lines.push(...leaf.options.map((option) => optionLine(option, locale)));
  }
  return joinWithin(lines, MAX_FIELD_VALUE);
}

/**
 * How to run an entry: the path (tappable when Discord knows its id) with
 * each option, one field per subcommand of a group, then any examples.
 */
function detailFields(
  entry: CommandInfo,
  locale: Locale,
  mentions: boolean,
  withOptions: boolean
): Field[] {
  const leaves = entry.leaves ?? [];
  const examples = leaves.flatMap((leaf) =>
    (leaf.examples ?? []).map((example) => example[locale])
  );
  const fields: Field[] = [];

  if (isRunnable(entry)) {
    fields.push({
      name: t('help.usage', locale),
      value: leafBlock(leaves[0], locale, mentions, withOptions),
      inline: false,
    });
  } else if (leaves.length > 0) {
    const room = MAX_FIELDS - (examples.length > 0 ? 1 : 0);
    for (const leaf of leaves.slice(0, room)) {
      fields.push({
        name: leaf.description[locale],
        value: leafBlock(leaf, locale, mentions, withOptions),
        inline: false,
      });
    }
  } else if (entry.usage) {
    fields.push({
      name: t('help.usage', locale),
      value: `\`${entry.usage}\``,
      inline: false,
    });
  }

  if (examples.length > 0) {
    fields.push({
      name: t('help.examples', locale),
      value: joinWithin(examples, MAX_FIELD_VALUE),
      inline: false,
    });
  }

  return fields;
}

/**
 * One entry in full: what it does, who may use it, and how to run each of
 * its subcommands with their options.
 */
export function buildDetailEmbed(
  entry: CommandInfo,
  locale: Locale
): EmbedBuilder {
  const title = `/${entry.name}`;
  const requires = formatPermissionAlternatives(entry, locale);
  const description = requires
    ? `${entry.description[locale]}\n\n${t('help.requires', locale, { permissions: requires })}`
    : entry.description[locale];

  let fields = detailFields(entry, locale, true, true);
  if (embedTextLength({ title, description, fields }) > MAX_EMBED_TEXT) {
    fields = detailFields(entry, locale, false, false);
  }

  return createEmbed({
    title,
    description,
    color: COLORS.PRIMARY,
    fields: fields.length > 0 ? fields : undefined,
    timestamp: true,
  });
}

/** What the asker typed, safe inside a code span and of bounded length. */
function echoQuery(query: string): string {
  const cleaned = query.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  return shorten(cleaned, MAX_QUERY_ECHO) || '?';
}

function buildNoMatchEmbed(
  query: string,
  suggestion: CommandInfo | null,
  locale: Locale
): EmbedBuilder {
  const lines = [t('help.noMatch', locale, { query: echoQuery(query) })];
  if (suggestion) {
    lines.push(
      t('help.didYouMean', locale, {
        suggestion: entryReference(suggestion, true),
      })
    );
  }
  lines.push(
    '',
    t('help.noMatchHint', locale, { help: commandMention(HELP_COMMAND_PATH) })
  );

  return createEmbed({
    title: t('help.commandNotFound', locale),
    description: lines.join('\n'),
    color: COLORS.WARNING,
  });
}

function buildMatchesEmbed(
  query: string,
  entries: CommandInfo[],
  locale: Locale
): EmbedBuilder {
  const hint = t('help.matchesHint', locale);
  const list = renderEntryLines(
    entries.slice(0, MAX_LISTED_MATCHES),
    locale,
    MAX_DESCRIPTION - hint.length - 2
  );

  return createEmbed({
    title: t('help.matchesTitle', locale, { query: echoQuery(query) }),
    description: `${list}\n\n${hint}`,
    color: COLORS.PRIMARY,
    footer: t('help.filteredFooter', locale),
  });
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

/** `voice record - 今いるVCの…`, never past Discord's 100 characters. */
function choiceLabel(entry: CommandInfo, locale: Locale): string {
  const separator = ' - ';
  const room = MAX_CHOICE_NAME - entry.name.length - separator.length;
  if (room < 2) return shorten(entry.name, MAX_CHOICE_NAME);
  return `${entry.name}${separator}${shorten(
    entry.description[locale],
    Math.min(SUGGESTION_PREVIEW, room)
  )}`;
}

/**
 * Suggest visible entries for what is typed so far: by path first, then by
 * a word of a path (`record`, `exclude`), then by description in either
 * language (`投票`, `poll`), best first.
 */
export async function autocompleteHelpCommand(
  interaction: AutocompleteInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const ranked = searchEntries(
    helpIndexOf(interaction),
    interaction.options.getFocused(),
    visibilityOf(interaction)
  );

  await interaction.respond(
    ranked.slice(0, MAX_AUTOCOMPLETE_CHOICES).map(({ indexed }) => ({
      name: choiceLabel(indexed.entry, locale),
      value: indexed.entry.name,
    }))
  );
}

// ---------------------------------------------------------------------------
// /general help
// ---------------------------------------------------------------------------

/**
 * `/general help command:<text>`: the entry it names, or the clear best
 * match; several equally good matches are listed; nothing matching gets a
 * private "not found" with a guess at a typo.
 *
 * Only a match on a path or on what the entry itself says decides the
 * answer. When the best is weaker - its command's description, its
 * category, a parenthetical note - every match is listed instead, so one
 * stray word (`（録音ではありません）`) never opens the wrong page.
 */
async function answerQuery(
  interaction: ChatInputCommandInteraction,
  query: string,
  locale: Locale,
  ephemeral: boolean
): Promise<void> {
  const index = helpIndexOf(interaction);
  const isVisible = visibilityOf(interaction);
  const ranked = searchEntries(index, query, isVisible);
  const flags = privacyFlags(ephemeral);

  if (ranked.length === 0) {
    // A typo is the asker's to fix; retrying must not hit the cooldown.
    releaseCooldown(interaction);
    const suggestion = closestEntry(index, query, isVisible);
    await interaction.reply({
      embeds: [buildNoMatchEmbed(query, suggestion?.entry ?? null, locale)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [best, runnerUp] = ranked;
  const decisive = best.score >= MATCH_SCORE.text;
  if (
    best.score === MATCH_SCORE.exact ||
    (decisive && (!runnerUp || best.score > runnerUp.score))
  ) {
    await interaction.reply({
      embeds: [buildDetailEmbed(best.indexed.entry, locale)],
      ...flags,
    });
    return;
  }

  const listed = (
    decisive ? ranked.filter((match) => match.score === best.score) : ranked
  ).map((match) => match.indexed.entry);
  await interaction.reply({
    embeds: [buildMatchesEmbed(query, listed, locale)],
    ...flags,
  });
}

function categoryIndexOf(
  value: string,
  categories: CommandCategory[]
): number | null {
  const match = /^cat_(\d+)$/.exec(value);
  if (!match) return null;
  const index = Number(match[1]);
  return index < categories.length ? index : null;
}

/**
 * The overview as a panel: a category menu (when there is more than one), a
 * menu of the listed commands that opens a command's detail in place, and a
 * button back to the list from a detail.
 */
async function showOverview(
  interaction: ChatInputCommandInteraction,
  locale: Locale,
  ephemeral: boolean
): Promise<void> {
  const isVisible = visibilityOf(interaction);
  const categories = helpIndexOf(interaction)
    .categories.map((category) => ({
      ...category,
      commands: category.commands.filter(isVisible),
    }))
    .filter((category) => category.commands.length > 0);

  let selectedCategory: number | null = null;
  let selectedEntry: CommandInfo | null = null;

  const listedEntries = (): CommandInfo[] =>
    selectedCategory === null
      ? categories.flatMap((category) => category.commands)
      : categories[selectedCategory].commands;

  const buildRows = (disabled: boolean) => {
    const rows: Array<
      | ActionRowBuilder<StringSelectMenuBuilder>
      | ActionRowBuilder<ButtonBuilder>
    > = [];

    if (categories.length > 1) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(CATEGORY_SELECT_ID)
        .setPlaceholder(t('help.selectCategory', locale))
        .setDisabled(disabled)
        .addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel(t('help.showAll', locale))
            .setValue('all')
            .setDefault(selectedCategory === null),
          ...categories.map((category, index) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(shorten(category.name[locale], MAX_SELECT_TEXT))
              .setValue(`cat_${index}`)
              .setDefault(selectedCategory === index)
          )
        );
      rows.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
      );
    }

    // A select holds 25 options; past that, picking a category comes first.
    const entries = listedEntries();
    if (entries.length > 0 && entries.length <= MAX_SELECT_OPTIONS) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(COMMAND_SELECT_ID)
        .setPlaceholder(t('help.selectCommand', locale))
        .setDisabled(disabled)
        .addOptions(
          entries.map((entry) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(shorten(`/${entry.name}`, MAX_SELECT_TEXT))
              .setValue(entry.name)
              .setDescription(
                shorten(entry.description[locale], MAX_SELECT_TEXT)
              )
              .setDefault(selectedEntry?.name === entry.name)
          )
        );
      rows.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
      );
    }

    if (selectedEntry) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(BACK_BUTTON_ID)
            .setLabel(t('help.back', locale))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
        )
      );
    }

    return rows;
  };

  const renderEmbed = (): EmbedBuilder => {
    if (selectedEntry) return buildDetailEmbed(selectedEntry, locale);
    if (selectedCategory !== null) {
      return buildCategoryEmbed(categories[selectedCategory], locale);
    }
    return buildOverviewEmbed(categories, locale, true);
  };

  const flags = privacyFlags(ephemeral);
  if (buildRows(false).length === 0) {
    // Nothing to pick from: no visible command, or one category too long
    // for a menu. Send the list alone.
    await interaction.reply({
      embeds: [buildOverviewEmbed(categories, locale, false)],
      ...flags,
    });
    return;
  }

  const rejectUnknown = async (
    componentInteraction: MessageComponentInteraction,
    value: string
  ) => {
    await componentInteraction.reply({
      content: t('help.commandNotFoundDesc', locale, { command: value }),
      flags: MessageFlags.Ephemeral,
    });
  };

  await runComponentPanel({
    interaction,
    locale,
    label: 'help panel',
    ephemeral,
    reopenCommand: HELP_COMMAND_PATH,
    render: () => ({ embeds: [renderEmbed()], components: buildRows(false) }),
    renderDisabled: () => buildRows(true),
    onComponent: async (componentInteraction) => {
      const { customId } = componentInteraction;

      if (customId === BACK_BUTTON_ID) {
        selectedEntry = null;
        return 'update';
      }

      if (!componentInteraction.isStringSelectMenu()) {
        // Not one of ours; acknowledge so Discord shows no failure.
        await componentInteraction.deferUpdate();
        return 'handled';
      }

      const value = componentInteraction.values[0] ?? '';

      if (customId === CATEGORY_SELECT_ID) {
        if (value === 'all') {
          selectedCategory = null;
          selectedEntry = null;
          return 'update';
        }
        const index = categoryIndexOf(value, categories);
        if (index === null) {
          await rejectUnknown(componentInteraction, value);
          return 'handled';
        }
        selectedCategory = index;
        selectedEntry = null;
        return 'update';
      }

      if (customId === COMMAND_SELECT_ID) {
        const entry = listedEntries().find((e) => e.name === value);
        if (!entry) {
          await rejectUnknown(componentInteraction, value);
          return 'handled';
        }
        selectedEntry = entry;
        return 'update';
      }

      await componentInteraction.deferUpdate();
      return 'handled';
    },
  });
}

/**
 * `/general help [command] [public]`. Help answers privately unless the
 * asker chooses to show it to the channel (`public`); a miss is always
 * private.
 */
export async function executeHelpCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const query = interaction.options.getString('command');
  const ephemeral = interaction.options.getBoolean('public') !== true;

  if (query !== null && query.trim() !== '') {
    await answerQuery(interaction, query, locale, ephemeral);
    return;
  }

  await showOverview(interaction, locale, ephemeral);
}
