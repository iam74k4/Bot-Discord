import {
  ApplicationCommandOptionType,
  SlashCommandBuilder,
  type APIApplicationCommandSubcommandOption,
  type APIEmbed,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeGeneralCommand } from '../application/general.js';
import { command } from '../commands/general.js';
import { buildHelpCatalog } from '../../../shared/help/catalog.js';
import { t, type Locale } from '../../../locales/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import {
  autocompleteInteraction,
  chatInteraction,
  embedAt,
  helpCommand,
  payloadAt,
  type ChatInteractionOptions,
} from './general.helpers.js';

/**
 * `/general` is the entry point: `help` and `ping` hand off to their own
 * modules (exercised for real, not mocked), `about` answers inline with the
 * runtime environment and how many commands are loaded.
 */

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const resolveLocale = vi.hoisted(() => vi.fn());
vi.mock('../../../locales/guildLocale.js', () => ({ resolveLocale }));

// The real config, loaded with a known owner and environment.
vi.mock('../../../config/env.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../config/env.js')>();
  actual.loadConfig({ BOT_OWNER_IDS: 'owner-1', NODE_ENV: 'production' });
  return actual;
});

const NOW = new Date('2026-05-01T12:00:00Z').getTime();

const json =
  command.data.toJSON() as RESTPostAPIChatInputApplicationCommandsJSONBody;
const subcommands = (json.options ??
  []) as APIApplicationCommandSubcommandOption[];

function extraCommand(name: string, withHelp = true) {
  return helpCommand(
    new SlashCommandBuilder().setName(name).setDescription(name),
    withHelp ? { category: { en: 'Extra', ja: '追加' } } : undefined
  );
}

async function runGeneral(options: ChatInteractionOptions) {
  const stub = chatInteraction({ commands: [command], ...options });
  await executeGeneralCommand(stub.interaction);
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

describe('/general about', () => {
  it('replies publicly with the environment and the loaded command count', async () => {
    const { reply, interaction } = await runGeneral({
      subcommand: 'about',
      commands: [command, extraCommand('one'), extraCommand('two')],
    });

    expect(resolveLocale).toHaveBeenCalledWith(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(payloadAt(reply).flags).toBeUndefined();

    const embed = embedAt(reply);
    expect(embed.color).toBe(COLORS.INFO);
    expect(embed.title?.length).toBeGreaterThan(0);
    expect(embed.description?.length).toBeGreaterThan(0);
    expect(embed.fields).toEqual([
      { name: expect.any(String), value: 'production', inline: true },
      { name: expect.any(String), value: '3', inline: true },
    ]);
  });

  it('counts commands that are loaded but not listed in help', async () => {
    const { reply } = await runGeneral({
      subcommand: 'about',
      commands: [command, extraCommand('quiet', false)],
    });

    expect(embedAt(reply).fields?.[1].value).toBe('2');
  });

  it('reports zero when no commands are loaded', async () => {
    const { reply } = await runGeneral({ subcommand: 'about', commands: [] });

    expect(embedAt(reply).fields?.[1].value).toBe('0');
  });

  it('localizes every label while keeping the values', async () => {
    const render = async (locale: Locale): Promise<APIEmbed> => {
      resolveLocale.mockReturnValue(locale);
      const { reply } = await runGeneral({ subcommand: 'about' });
      return embedAt(reply);
    };

    const en = await render('en');
    const ja = await render('ja');

    expect(ja.title).not.toBe(en.title);
    expect(ja.description).not.toBe(en.description);
    expect(ja.fields?.map((f) => f.name)).not.toEqual(
      en.fields?.map((f) => f.name)
    );
    expect(ja.fields?.map((f) => f.value)).toEqual(
      en.fields?.map((f) => f.value)
    );
    // The Japanese reply really is Japanese, not the English copy.
    for (const text of [
      ja.title,
      ja.description,
      ...(ja.fields ?? []).map((f) => f.name),
    ]) {
      expect(text).toMatch(/[぀-ヿ一-鿿]/);
    }
    for (const text of [
      en.title,
      en.description,
      ...(en.fields ?? []).map((f) => f.name),
    ]) {
      expect(text).not.toMatch(/[぀-ヿ一-鿿]/);
    }
  });
});

describe('/general routing', () => {
  it('hands help to the help overview', async () => {
    const { reply, deferReply } = await runGeneral({ subcommand: 'help' });

    expect(deferReply).not.toHaveBeenCalled();
    expect(embedAt(reply)).toMatchObject({
      title: t('help.title', 'en'),
      fields: [{ name: 'General' }],
    });
  });

  it('passes the command option through to help', async () => {
    const { reply } = await runGeneral({
      subcommand: 'help',
      commandOption: 'general ping',
    });

    expect(embedAt(reply).title).toBe('/general ping');
  });

  it('hands ping to the latency check', async () => {
    const { reply, deferReply, editReply } = await runGeneral({
      subcommand: 'ping',
      createdTimestamp: NOW,
      deferReply: vi.fn().mockResolvedValue({
        resource: { message: { createdTimestamp: NOW + 20 } },
      }),
      wsPing: 33,
    });

    expect(reply).not.toHaveBeenCalled();
    expect(deferReply).toHaveBeenCalledWith({ withResponse: true });
    expect(embedAt(editReply)).toMatchObject({
      title: t('ping.title', 'en'),
      fields: [{ value: '20ms' }, { value: '33ms' }],
    });
  });

  it('does nothing for an unknown subcommand', async () => {
    const { reply, deferReply, editReply } = await runGeneral({
      subcommand: 'unknown',
    });

    expect(reply).not.toHaveBeenCalled();
    expect(deferReply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });
});

describe('/general command definition', () => {
  it('registers help, ping and about as subcommands', () => {
    expect(json.name).toBe('general');
    expect(json.description_localizations?.ja).toBeTruthy();
    expect(subcommands.map((s) => [s.name, s.type])).toEqual([
      ['help', ApplicationCommandOptionType.Subcommand],
      ['ping', ApplicationCommandOptionType.Subcommand],
      ['about', ApplicationCommandOptionType.Subcommand],
    ]);
    for (const sub of subcommands) {
      expect(sub.description_localizations?.ja, sub.name).toBeTruthy();
    }
  });

  it('gives help an optional, autocompleted command option', () => {
    const help = subcommands.find((s) => s.name === 'help');

    expect(help?.options).toEqual([
      expect.objectContaining({
        name: 'command',
        type: ApplicationCommandOptionType.String,
        autocomplete: true,
      }),
    ]);
    expect(help?.options?.[0].required ?? false).toBe(false);
    expect(help?.options?.[0].description_localizations?.ja).toBeTruthy();
  });

  it('runs behind a 3 second cooldown', () => {
    expect(command.middleware).toEqual(['cooldown']);
    expect(command.options?.cooldown).toBe(3000);
    expect(command.options?.permissions).toBeUndefined();
  });

  it('lists every subcommand in help, open to everyone', () => {
    const [category] = buildHelpCatalog([command]);

    expect(category.name).toEqual({ en: 'General', ja: '一般' });
    expect(category.commands).toEqual(
      subcommands.map((sub) => ({
        name: `general ${sub.name}`,
        description: {
          en: sub.description,
          ja: sub.description_localizations?.ja,
        },
        usage: `/general ${sub.name}`,
        requiredPermission: 'everyone',
      }))
    );
  });

  it('executes through the application layer', async () => {
    const { interaction, reply } = chatInteraction({
      subcommand: 'about',
      commands: [command],
    });

    await command.execute(interaction);

    expect(embedAt(reply).fields?.[1].value).toBe('1');
  });

  it('autocompletes help with the loaded commands', async () => {
    const { interaction, respond } = autocompleteInteraction({
      commands: [command],
      focused: 'general p',
    });

    await command.autocomplete?.(interaction);

    const ping = subcommands.find((s) => s.name === 'ping');
    expect(respond).toHaveBeenCalledWith([
      { name: `general ping - ${ping?.description}`, value: 'general ping' },
    ]);
  });
});
