import {
  ApplicationCommandOptionType,
  ChannelType,
  type ChatInputCommandInteraction,
  InteractionContextType,
  PermissionFlagsBits,
} from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `/voice` command definition (commands/voice.ts): what Discord is told
 * about the command, and which handler each subcommand reaches. The handlers
 * themselves are covered in their own files.
 */
const executeAutoJoinCommand = vi.hoisted(() => vi.fn());
const executeRecordCommand = vi.hoisted(() => vi.fn());
const executeStatusCommand = vi.hoisted(() => vi.fn());

vi.mock('../application/index.js', () => ({
  executeAutoJoinCommand,
  executeRecordCommand,
  executeStatusCommand,
}));

const { command } = await import('../commands/voice.js');
const { resolveCooldownMs } = await import('../../../middleware/index.js');
const { parseDurationString } = await vi.importActual<
  typeof import('../recording/recordingService.js')
>('../recording/recordingService.js');

type OptionJSON = {
  name: string;
  name_localizations?: Record<string, string>;
  type: ApplicationCommandOptionType;
  required?: boolean;
  options?: OptionJSON[];
  choices?: Array<{
    name: string;
    name_localizations?: Record<string, string>;
    value: string;
  }>;
  channel_types?: ChannelType[];
};

const json = command.data.toJSON() as unknown as {
  name: string;
  options: OptionJSON[];
  default_member_permissions?: string | null;
  contexts?: InteractionContextType[];
};

function option(name: string, from: OptionJSON[] = json.options): OptionJSON {
  const found = from.find((o) => o.name === name);
  expect(found, `option "${name}"`).toBeDefined();
  return found!;
}

function interactionFor(group: string | null, subcommand: string) {
  return {
    options: {
      getSubcommandGroup: vi.fn(() => group),
      getSubcommand: vi.fn(() => subcommand),
    },
  } as unknown as ChatInputCommandInteraction;
}

describe('/voice command definition', () => {
  it('registers as /voice with record, status and the autojoin group', () => {
    expect(json.name).toBe('voice');
    expect(json.options.map((o) => o.name).sort()).toEqual([
      'autojoin',
      'record',
      'status',
    ]);
    expect(option('autojoin').type).toBe(
      ApplicationCommandOptionType.SubcommandGroup
    );
    expect(
      option('autojoin')
        .options?.map((o) => o.name)
        .sort()
    ).toEqual(['disable', 'enable', 'exclude', 'include']);
  });

  it('only offers voice and stage channels for exclude/include, and requires one', () => {
    for (const sub of ['exclude', 'include']) {
      const channel = option(
        'channel',
        option(sub, option('autojoin').options).options
      );
      expect(channel.type).toBe(ApplicationCommandOptionType.Channel);
      expect(channel.required).toBe(true);
      expect(channel.channel_types?.sort()).toEqual(
        [ChannelType.GuildVoice, ChannelType.GuildStageVoice].sort()
      );
    }
  });

  it('only offers record durations the parser accepts, capped at five minutes', () => {
    const duration = option('duration', option('record').options);
    expect(duration.required).toBe(true);

    const seconds = duration.choices!.map((c) => parseDurationString(c.value));
    expect(seconds).toEqual([30, 60, 120, 180, 300]);
  });

  it('is limited to server managers, and checked again on every run', () => {
    expect(command.middleware).toEqual(['permissions', 'cooldown']);
    expect(command.options?.permissions).toEqual([
      PermissionFlagsBits.ManageGuild,
    ]);
  });

  it('is hidden from members by default and offered in servers only', () => {
    expect(json.default_member_permissions).toBe(
      PermissionFlagsBits.ManageGuild.toString()
    );
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
  });

  it('rate limits recording, not looking at the status or changing settings', () => {
    expect(resolveCooldownMs(command, 'voice record')).toBe(10_000);
    expect(resolveCooldownMs(command, 'voice status')).toBe(3_000);
    expect(resolveCooldownMs(command, 'voice autojoin exclude')).toBe(3_000);
  });

  it('labels the record duration as how far back to go, in Japanese too', () => {
    const duration = option('duration', option('record').options);
    expect(duration.name_localizations).toEqual({ ja: 'さかのぼる長さ' });
    expect(duration.choices?.map((c) => c.name_localizations?.ja)).toEqual([
      '直前30秒',
      '直前1分',
      '直前2分',
      '直前3分',
      '直前5分（最大）',
    ]);
    for (const sub of ['exclude', 'include']) {
      expect(
        option('channel', option(sub, option('autojoin').options).options)
          .name_localizations
      ).toEqual({ ja: 'チャンネル' });
    }
  });
});

describe('/voice routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['enable', 'disable', 'exclude', 'include'])(
    'sends autojoin %s to the auto-join handler',
    async (subcommand) => {
      const interaction = interactionFor('autojoin', subcommand);

      await command.execute(interaction);

      expect(executeAutoJoinCommand).toHaveBeenCalledWith(interaction);
      expect(executeRecordCommand).not.toHaveBeenCalled();
      expect(executeStatusCommand).not.toHaveBeenCalled();
      // A missing group must not throw, so it is read as optional.
      expect(interaction.options.getSubcommandGroup).toHaveBeenCalledWith(
        false
      );
    }
  );

  it('sends record to the record handler', async () => {
    const interaction = interactionFor(null, 'record');

    await command.execute(interaction);

    expect(executeRecordCommand).toHaveBeenCalledWith(interaction);
    expect(executeAutoJoinCommand).not.toHaveBeenCalled();
    expect(executeStatusCommand).not.toHaveBeenCalled();
  });

  it('sends status to the status handler', async () => {
    const interaction = interactionFor(null, 'status');

    await command.execute(interaction);

    expect(executeStatusCommand).toHaveBeenCalledWith(interaction);
    expect(executeAutoJoinCommand).not.toHaveBeenCalled();
    expect(executeRecordCommand).not.toHaveBeenCalled();
  });

  it('propagates handler failures to the command framework', async () => {
    executeStatusCommand.mockRejectedValueOnce(new Error('boom'));

    await expect(
      command.execute(interactionFor(null, 'status'))
    ).rejects.toThrow('boom');
  });
});
