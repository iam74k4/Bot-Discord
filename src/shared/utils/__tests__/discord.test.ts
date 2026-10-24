import {
  ChatInputCommandInteraction,
  Guild,
  PermissionFlagsBits,
  PermissionsBitField,
  TextChannel,
  VoiceChannel,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  getSendableTextChannel,
  hasPermission,
  interactionHasGuildPermission,
} from '../discord.js';

function createInteraction(
  permissions?: bigint[],
  inGuild: boolean = true
): ChatInputCommandInteraction {
  return {
    guild: inGuild ? { id: 'guild-1' } : null,
    member: inGuild
      ? { permissions: new PermissionsBitField(permissions ?? []) }
      : null,
  } as unknown as ChatInputCommandInteraction;
}

/**
 * A real TextChannel instance (so `instanceof` holds) whose permission lookup
 * returns `permissions` for whoever asks.
 */
function createTextChannelMock(
  permissions: PermissionsBitField | null
): TextChannel {
  const channel = Object.create(TextChannel.prototype) as TextChannel;
  vi.spyOn(channel, 'permissionsFor').mockReturnValue(permissions);
  return channel;
}

const canSend = () =>
  new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
  ]);

const me = { id: 'bot-1' };

function createGuild(
  options: {
    cached?: Record<string, unknown>;
    fetch?: ReturnType<typeof vi.fn>;
    me?: unknown;
  } = {}
) {
  const fetch = options.fetch ?? vi.fn().mockResolvedValue(null);
  const guild = {
    channels: {
      cache: new Map(Object.entries(options.cached ?? {})),
      fetch,
    },
    members: {
      me: 'me' in options ? options.me : me,
    },
  } as unknown as Guild;
  return { guild, fetch };
}

describe('discord utils', () => {
  describe('hasPermission', () => {
    it('checks permission objects safely', () => {
      expect(
        hasPermission(
          {
            permissions: new PermissionsBitField([
              PermissionFlagsBits.ManageGuild,
            ]),
          },
          PermissionFlagsBits.ManageGuild
        )
      ).toBe(true);
      expect(hasPermission({}, PermissionFlagsBits.ManageGuild)).toBe(false);
    });

    it('accepts a bare PermissionsBitField', () => {
      const bits = new PermissionsBitField([PermissionFlagsBits.KickMembers]);

      expect(hasPermission(bits, PermissionFlagsBits.KickMembers)).toBe(true);
      expect(hasPermission(bits, PermissionFlagsBits.BanMembers)).toBe(false);
    });

    it('denies a member whose permissions are not a resolved bitfield', () => {
      // An uncached API member carries permissions as a string.
      expect(
        hasPermission({ permissions: '8' }, PermissionFlagsBits.Administrator)
      ).toBe(false);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a number', 8],
      ['a string', 'Administrator'],
    ])('denies %s', (_label, value) => {
      expect(hasPermission(value, PermissionFlagsBits.Administrator)).toBe(
        false
      );
    });
  });

  describe('interactionHasGuildPermission', () => {
    it('checks interaction guild permissions', () => {
      const allowed = createInteraction([PermissionFlagsBits.ManageGuild]);
      const denied = createInteraction([]);
      const dm = createInteraction(undefined, false);

      expect(
        interactionHasGuildPermission(allowed, PermissionFlagsBits.ManageGuild)
      ).toBe(true);
      expect(
        interactionHasGuildPermission(denied, PermissionFlagsBits.ManageGuild)
      ).toBe(false);
      expect(
        interactionHasGuildPermission(dm, PermissionFlagsBits.ManageGuild)
      ).toBe(false);
    });

    it('denies when the guild is known but the member is missing', () => {
      const interaction = {
        guild: { id: 'guild-1' },
        member: null,
      } as unknown as ChatInputCommandInteraction;

      expect(
        interactionHasGuildPermission(
          interaction,
          PermissionFlagsBits.ManageGuild
        )
      ).toBe(false);
    });
  });

  describe('getSendableTextChannel', () => {
    it('returns a sendable text channel when the bot can post', async () => {
      const channel = createTextChannelMock(canSend());
      const { guild, fetch } = createGuild({
        cached: { 'channel-1': channel },
      });

      const result = await getSendableTextChannel(guild, 'channel-1');

      expect(result).toBe(channel);
      expect(channel.permissionsFor).toHaveBeenCalledWith(me);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('returns null when the bot cannot post to the channel', async () => {
      const channel = createTextChannelMock(null);
      const { guild } = createGuild({ cached: { 'channel-1': channel } });

      const result = await getSendableTextChannel(guild, 'channel-1');

      expect(result).toBeNull();
    });

    it('returns null when the bot can see but not send', async () => {
      const channel = createTextChannelMock(
        new PermissionsBitField([PermissionFlagsBits.ViewChannel])
      );
      const { guild } = createGuild({ cached: { 'channel-1': channel } });

      await expect(
        getSendableTextChannel(guild, 'channel-1')
      ).resolves.toBeNull();
    });

    it('fetches the channel when it is not cached', async () => {
      const channel = createTextChannelMock(canSend());
      const { guild, fetch } = createGuild({
        fetch: vi.fn().mockResolvedValue(channel),
      });

      const result = await getSendableTextChannel(guild, 'channel-9');

      expect(fetch).toHaveBeenCalledWith('channel-9');
      expect(result).toBe(channel);
    });

    it('returns null when the fetch fails (deleted channel, missing access)', async () => {
      const { guild } = createGuild({
        fetch: vi.fn().mockRejectedValue(new Error('Unknown Channel')),
      });

      await expect(
        getSendableTextChannel(guild, 'channel-9')
      ).resolves.toBeNull();
    });

    it('returns null when the channel does not exist', async () => {
      const { guild } = createGuild();

      await expect(
        getSendableTextChannel(guild, 'channel-9')
      ).resolves.toBeNull();
    });

    it.each([
      ['a voice channel', () => Object.create(VoiceChannel.prototype)],
      [
        'a text-like plain object',
        () => ({ permissionsFor: () => canSend(), send: vi.fn() }),
      ],
    ])('returns null for %s', async (_label, build) => {
      const { guild } = createGuild({ cached: { 'channel-1': build() } });

      await expect(
        getSendableTextChannel(guild, 'channel-1')
      ).resolves.toBeNull();
    });

    it('returns null when the bot member is not cached', async () => {
      const channel = createTextChannelMock(canSend());
      const { guild } = createGuild({
        cached: { 'channel-1': channel },
        me: null,
      });

      await expect(
        getSendableTextChannel(guild, 'channel-1')
      ).resolves.toBeNull();
      expect(channel.permissionsFor).not.toHaveBeenCalled();
    });
  });
});
