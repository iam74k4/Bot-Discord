import { Events, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const resolveBackgroundLocale = vi.hoisted(() => vi.fn(() => 'ja'));
vi.mock('../../../locales/guildLocale.js', () => ({ resolveBackgroundLocale }));

const reconcileGuild = vi.hoisted(() => vi.fn());
vi.mock('../application/reconcile.js', () => ({ reconcileGuild }));

const { welcomeNewGuild } = await import('../application/onboarding.js');
const { event } = await import('../events/guildCreate.js');
const { t } = await import('../../../locales/index.js');
const { logger } = await import('../../../shared/utils/logger.js');

const ALL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ManageRoles,
];

function guildStub(
  options: {
    granted?: bigint[];
    systemChannel?: boolean;
    canPostInSystemChannel?: boolean;
  } = {}
) {
  const permissions = new PermissionsBitField(options.granted ?? ALL);
  const ownerSend = vi.fn(async () => undefined);
  const systemSend = vi.fn(async () => undefined);
  const guild = {
    id: 'guild-1',
    name: 'Guild',
    members: { me: { id: 'bot', permissions } },
    systemChannel:
      options.systemChannel === false
        ? null
        : {
            permissionsFor: () => ({
              has: () => options.canPostInSystemChannel !== false,
            }),
            send: systemSend,
          },
    fetchOwner: vi.fn(async () => ({ send: ownerSend })),
  };
  return { guild, ownerSend, systemSend };
}

type EmbedJSON = ReturnType<
  ReturnType<
    typeof import('../application/onboarding.js').buildOnboardingEmbed
  >['toJSON']
>;

function sentEmbed(send: ReturnType<typeof vi.fn>): EmbedJSON {
  const [payload] = send.mock.calls[0] as unknown as [
    { embeds: Array<{ toJSON(): EmbedJSON }> },
  ];
  return payload.embeds[0].toJSON();
}

describe('welcomeNewGuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveBackgroundLocale.mockReturnValue('ja');
  });

  it('posts in the system channel when the bot may', async () => {
    const { guild, systemSend, ownerSend } = guildStub();

    await welcomeNewGuild(guild as never);

    expect(systemSend).toHaveBeenCalledTimes(1);
    expect(ownerSend).not.toHaveBeenCalled();
    const embed = sentEmbed(systemSend);
    expect(embed.title).toBe(t('onboarding.title', 'ja'));
    expect(resolveBackgroundLocale).toHaveBeenCalledWith(guild);
  });

  it('explains the audio buffering and how to turn it off before anything else', async () => {
    const { guild, systemSend } = guildStub();

    await welcomeNewGuild(guild as never);

    const [buffering, setup] = sentEmbed(systemSend).fields ?? [];
    expect(buffering.name).toBe(t('onboarding.bufferingTitle', 'ja'));
    expect(buffering.value).toContain('`/voice autojoin disable`');
    expect(buffering.value).toContain('`/voice autojoin exclude`');
    expect(setup.name).toBe(t('onboarding.setupTitle', 'ja'));
    expect(setup.value).toContain('`/admin settings language`');
  });

  it('DMs the owner instead when it cannot post in the system channel', async () => {
    const { guild, systemSend, ownerSend } = guildStub({
      canPostInSystemChannel: false,
    });

    await welcomeNewGuild(guild as never);

    expect(systemSend).not.toHaveBeenCalled();
    expect(ownerSend).toHaveBeenCalledTimes(1);
  });

  it('DMs the owner when the server has no system channel', async () => {
    const { guild, ownerSend } = guildStub({ systemChannel: false });

    await welcomeNewGuild(guild as never);

    expect(ownerSend).toHaveBeenCalledTimes(1);
  });

  it('lists only the permissions the bot is missing, with what breaks', async () => {
    const { guild, systemSend } = guildStub({
      granted: ALL.filter(
        (flag) =>
          flag !== PermissionFlagsBits.Connect &&
          flag !== PermissionFlagsBits.ManageRoles
      ),
    });

    await welcomeNewGuild(guild as never);

    const missing = sentEmbed(systemSend).fields?.find(
      (field) => field.name === t('onboarding.missingTitle', 'ja')
    );
    expect(missing?.value.split('\n')).toEqual([
      t('onboarding.missingLine', 'ja', {
        permission: '接続',
        effect: t('onboarding.missing.Connect', 'ja'),
      }),
      t('onboarding.missingLine', 'ja', {
        permission: 'ロールの管理',
        effect: t('onboarding.missing.ManageRoles', 'ja', {
          command: '`/admin role add`',
        }),
      }),
    ]);
  });

  it('leaves the missing-permissions part out when nothing is missing', async () => {
    const { guild, systemSend } = guildStub();

    await welcomeNewGuild(guild as never);

    expect(
      sentEmbed(systemSend).fields?.map((field) => field.name)
    ).not.toContain(t('onboarding.missingTitle', 'ja'));
  });

  it('never throws when nobody can be reached', async () => {
    const { guild } = guildStub({ systemChannel: false });
    guild.fetchOwner.mockRejectedValue(new Error('Cannot send to this user'));

    await expect(welcomeNewGuild(guild as never)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not send the welcome message')
    );
  });
});

describe('guildCreate event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reconcileGuild.mockResolvedValue({ status: 'none' });
  });

  it('is a recurring GuildCreate handler', () => {
    expect(event.name).toBe(Events.GuildCreate);
    expect(event.once).toBe(false);
  });

  it('welcomes the server first, then joins a channel people are already in', async () => {
    const { guild, systemSend } = guildStub();

    await event.execute({ isFullyReady: true } as never, guild as never);

    expect(systemSend).toHaveBeenCalledTimes(1);
    expect(reconcileGuild).toHaveBeenCalledWith(guild);
    expect(systemSend.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileGuild.mock.invocationCallOrder[0]
    );
  });

  it('does nothing before the bot is fully ready', async () => {
    const { guild, systemSend } = guildStub();

    await event.execute({ isFullyReady: false } as never, guild as never);

    expect(systemSend).not.toHaveBeenCalled();
    expect(reconcileGuild).not.toHaveBeenCalled();
  });

  it('survives a failed reconcile', async () => {
    const { guild } = guildStub();
    reconcileGuild.mockRejectedValue(new Error('boom'));

    await expect(
      event.execute({ isFullyReady: true } as never, guild as never)
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
