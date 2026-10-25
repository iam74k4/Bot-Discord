import {
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  PermissionsBitField,
  TextChannel,
  VoiceChannel,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  checkPostableTextChannel,
  createPermissionDeniedEmbed,
  formatPermissionNames,
  getSendableTextChannel,
  hasPermission,
  interactionHasGuildPermission,
  memberServerPermissions,
  permissionNames,
} from '../discord.js';
import { t } from '../../../locales/index.js';
import { COLORS } from '../constants/index.js';

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

/** Everything a bot needs to post an embed: View, Send, Embed Links. */
const canSend = () =>
  new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
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

    it('denies outside a cached guild even if the member carries the permission', () => {
      // Without a guild there is no server context to grant anything in, so a
      // resolved bitfield on the member must not be trusted on its own.
      const interaction = {
        guild: null,
        member: {
          permissions: new PermissionsBitField([
            PermissionFlagsBits.ManageGuild,
          ]),
        },
      } as unknown as ChatInputCommandInteraction;

      expect(
        interactionHasGuildPermission(
          interaction,
          PermissionFlagsBits.ManageGuild
        )
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

    it.each([
      ['send', PermissionFlagsBits.SendMessages],
      ['embed links', PermissionFlagsBits.EmbedLinks],
      ['see the channel', PermissionFlagsBits.ViewChannel],
    ])('returns null when the bot cannot %s', async (_label, missing) => {
      const granted = canSend().remove(missing);
      const channel = createTextChannelMock(granted);
      const { guild } = createGuild({ cached: { 'channel-1': channel } });

      // Every background post is an embed; it would only fail.
      await expect(
        getSendableTextChannel(guild, 'channel-1')
      ).resolves.toBeNull();
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

describe('checkPostableTextChannel', () => {
  it('names exactly the permissions the bot lacks, in a fixed order', async () => {
    const channel = createTextChannelMock(
      new PermissionsBitField([PermissionFlagsBits.SendMessages])
    );
    const { guild } = createGuild({ cached: { 'channel-1': channel } });

    await expect(checkPostableTextChannel(guild, 'channel-1')).resolves.toEqual(
      {
        ok: false,
        reason: 'missingPermissions',
        channel,
        missing: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.EmbedLinks,
        ],
      }
    );
  });

  it('treats an unreadable permission set as granting nothing', async () => {
    const channel = createTextChannelMock(null);
    const { guild } = createGuild({ cached: { 'channel-1': channel } });

    const check = await checkPostableTextChannel(guild, 'channel-1');

    expect(check).toMatchObject({ ok: false, reason: 'missingPermissions' });
  });

  it('accepts a channel with everything needed', async () => {
    const channel = createTextChannelMock(canSend());
    const { guild } = createGuild({ cached: { 'channel-1': channel } });

    await expect(checkPostableTextChannel(guild, 'channel-1')).resolves.toEqual(
      { ok: true, channel }
    );
  });

  it.each([
    ['a missing channel', createGuild()],
    [
      'a voice channel',
      createGuild({
        cached: { 'channel-1': Object.create(VoiceChannel.prototype) },
      }),
    ],
    [
      'an uncached bot member',
      createGuild({
        cached: { 'channel-1': createTextChannelMock(canSend()) },
        me: null,
      }),
    ],
  ])('reports %s as unavailable', async (_label, { guild }) => {
    await expect(checkPostableTextChannel(guild, 'channel-1')).resolves.toEqual(
      { ok: false, reason: 'unavailable' }
    );
  });
});

describe('memberServerPermissions', () => {
  const MANAGE_ROLES = new PermissionsBitField([
    PermissionFlagsBits.ManageRoles,
  ]);

  function guildMember(permissions: () => PermissionsBitField) {
    const member = Object.create(GuildMember.prototype) as GuildMember;
    Object.defineProperty(member, 'permissions', { get: permissions });
    return member;
  }

  it('uses a cached member’s server-wide permissions over the channel’s', () => {
    // The channel grants Manage Permissions (the Manage Roles bit) through
    // an overwrite; the member's roles do not.
    const result = memberServerPermissions({
      member: guildMember(() => new PermissionsBitField()),
      memberPermissions: MANAGE_ROLES,
    });

    expect(result?.has(PermissionFlagsBits.ManageRoles)).toBe(false);
  });

  it('falls back to what Discord sent when the member’s roles are not cached', () => {
    const result = memberServerPermissions({
      member: guildMember(() => {
        throw new Error('roles not cached');
      }),
      memberPermissions: MANAGE_ROLES,
    });

    expect(result).toBe(MANAGE_ROLES);
  });

  it('reads a stand-in member’s own field last, and gives up without one', () => {
    expect(
      memberServerPermissions({ member: { permissions: MANAGE_ROLES } })
    ).toBe(MANAGE_ROLES);
    expect(memberServerPermissions({ member: { permissions: 'x' } })).toBe(
      null
    );
    expect(memberServerPermissions({ member: null })).toBe(null);
  });
});

describe('permission names', () => {
  it('names a permission the way the Discord client does, not by its flag', () => {
    expect(permissionNames(PermissionFlagsBits.ManageGuild, 'ja')).toEqual([
      'サーバー管理',
    ]);
    expect(permissionNames(PermissionFlagsBits.ManageGuild, 'en')).toEqual([
      'Manage Server',
    ]);
    expect(permissionNames([PermissionFlagsBits.ManageRoles], 'ja')).toEqual([
      'ロールの管理',
    ]);
  });

  it('falls back to the flag name for a permission without a label', () => {
    expect(permissionNames(PermissionFlagsBits.UseVAD, 'ja')).toEqual([
      'UseVAD',
    ]);
  });

  it('joins several names the way each language lists them', () => {
    const both = [
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageRoles,
    ];

    expect(formatPermissionNames(both, 'ja')).toBe(
      '「サーバー管理」、「ロールの管理」'
    );
    expect(formatPermissionNames(both, 'en')).toBe(
      'Manage Server and Manage Roles'
    );
    expect(formatPermissionNames(PermissionFlagsBits.ManageGuild, 'ja')).toBe(
      '「サーバー管理」'
    );
  });

  it('reports a missing permission as a warning naming it', () => {
    const embed = createPermissionDeniedEmbed(
      PermissionFlagsBits.ManageGuild,
      'ja'
    ).toJSON();

    expect(embed).toMatchObject({
      title: t('common.permissionDeniedTitle', 'ja'),
      color: COLORS.WARNING,
    });
    expect(embed.description).toContain('「サーバー管理」');
    expect(embed.description).not.toContain('ManageGuild');
  });
});
