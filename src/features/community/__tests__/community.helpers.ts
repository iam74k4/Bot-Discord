import {
  ChannelType,
  Collection,
  type APIEmbed,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
} from 'discord.js';
import { expect, vi } from 'vitest';

/**
 * Stand-ins for the slices of discord.js the community feature reads. Each
 * factory builds only what the code under test touches, so a test that needs
 * a field the code never reads will fail loudly instead of passing by luck.
 */

export interface VoiceMemberStub {
  id: string;
  displayName: string;
  user: { bot: boolean };
}

export function voiceMember(
  id: string,
  options: { bot?: boolean; displayName?: string } = {}
): VoiceMemberStub {
  return {
    id,
    displayName: options.displayName ?? `Name-${id}`,
    user: { bot: options.bot ?? false },
  };
}

export interface VoiceChannelStub {
  name: string;
  type: ChannelType;
  members: Collection<string, VoiceMemberStub>;
}

export function voiceChannel(
  members: VoiceMemberStub[],
  options: { name?: string; type?: ChannelType } = {}
): VoiceChannelStub {
  return {
    name: options.name ?? 'Game Night',
    type: options.type ?? ChannelType.GuildVoice,
    members: new Collection(members.map((m) => [m.id, m])),
  };
}

export interface CommandInteractionStub {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  getString: ReturnType<typeof vi.fn>;
  getInteger: ReturnType<typeof vi.fn>;
}

/**
 * A slash command interaction. `channel` is the voice channel the invoking
 * member sits in (roulette); `textChannel` is where the command was run
 * (poll end fetches the poll message from it).
 */
export function commandInteraction(
  options: {
    group?: string | null;
    subcommand?: string | null;
    values?: Record<string, string | number | boolean | null>;
    voice?: VoiceChannelStub | null;
    hasGuild?: boolean;
    hasMember?: boolean;
    /** Used as `interaction.member` verbatim, e.g. an uncached API member. */
    rawMember?: unknown;
    userId?: string;
    guildId?: string | null;
    channelId?: string;
    textChannel?: unknown;
    reply?: ReturnType<typeof vi.fn>;
  } = {}
): CommandInteractionStub {
  const values = options.values ?? {};
  const read = (name: string) => values[name] ?? null;

  const reply = options.reply ?? vi.fn().mockResolvedValue({});
  const deferReply = vi.fn().mockResolvedValue({});
  const editReply = vi.fn().mockResolvedValue({});
  const getString = vi.fn(read);
  const getInteger = vi.fn(read);

  const userId = options.userId ?? 'user-1';
  const interaction = {
    id: 'interaction-1',
    guild: options.hasGuild === false ? null : { id: 'guild-1' },
    guildId: options.guildId === undefined ? 'guild-1' : options.guildId,
    member:
      options.rawMember !== undefined
        ? options.rawMember
        : options.hasMember === false
          ? null
          : { id: userId, voice: { channel: options.voice ?? null } },
    user: { id: userId, tag: `${userId}#0001` },
    channelId: options.channelId ?? 'chan-1',
    channel: options.textChannel ?? null,
    locale: 'en-US',
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(options.group ?? null),
      getSubcommand: vi.fn().mockReturnValue(options.subcommand ?? null),
      getString,
      getInteger,
      getBoolean: vi.fn(read),
    },
    reply,
    deferReply,
    editReply,
  } as unknown as ChatInputCommandInteraction;

  return { interaction, reply, deferReply, editReply, getString, getInteger };
}

/** The first embed of the payload passed in `call` of a reply/editReply mock. */
export function embedAt(mock: ReturnType<typeof vi.fn>, call = 0): APIEmbed {
  const payload = mock.mock.calls[call][0] as { embeds: EmbedBuilder[] };
  return payload.embeds[0].toJSON();
}

/** The first embed of the most recent reply/editReply call. */
export function lastEmbed(mock: ReturnType<typeof vi.fn>): APIEmbed {
  return embedAt(mock, mock.mock.calls.length - 1);
}

/**
 * Matches a string that mentions every part, in any order and case. Log lines
 * are checked for the facts they carry (who, how many) rather than their exact
 * wording, so rephrasing a log does not break a test.
 */
export function mentioning(...parts: Array<string | RegExp>) {
  const lookaheads = parts.map((part) => {
    const source =
      typeof part === 'string'
        ? part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        : part.source;
    return `(?=[\\s\\S]*${source})`;
  });
  return expect.stringMatching(new RegExp(lookaheads.join(''), 'i'));
}

/** The flags of the payload passed in `call`, or undefined when public. */
export function flagsAt(
  mock: ReturnType<typeof vi.fn>,
  call = 0
): number | undefined {
  return (mock.mock.calls[call][0] as { flags?: number }).flags;
}
