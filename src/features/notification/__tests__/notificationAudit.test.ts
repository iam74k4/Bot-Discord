import { ChannelType, ChatInputCommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifySetup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const notifyRemove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const set = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());

vi.mock('../../../infrastructure/audit/index.js', () => ({
  audit: { notifySetup, notifyRemove },
}));

vi.mock('../repositories/notificationChannelRepository.js', () => ({
  notificationChannelRepository: { set, remove },
}));

vi.mock('../application/channelCheck.js', () => ({
  checkNotificationChannel: vi
    .fn()
    .mockResolvedValue({ ok: true, channel: { id: 'channel-1' } }),
}));

vi.mock('../application/postLanguage.js', () => ({
  postLanguageLines: () => [],
}));

vi.mock('../application/panel.js', () => ({
  showNotificationPanel: vi.fn(),
}));

// The real resolver reads guild_settings, which would open the on-disk test
// database for 'guild-1'. Locale is not what these tests are about.
vi.mock('../../../locales/guildLocale.js', () => ({
  resolveLocale: () => 'en',
}));

const {
  handleVoiceSet,
  handleVoiceRemove,
  handleWelcomeSet,
  handleWelcomeRemove,
} = await import('../application/notification.js');

function createInteraction(): ChatInputCommandInteraction {
  return {
    locale: 'en-US',
    guildId: 'guild-1',
    guild: { id: 'guild-1' },
    client: { id: 'client-1' },
    user: { id: 'mod-1' },
    options: {
      getChannel: vi.fn().mockReturnValue({
        id: 'channel-1',
        type: ChannelType.GuildText,
      }),
    },
    reply: vi.fn().mockResolvedValue({}),
  } as unknown as ChatInputCommandInteraction;
}

describe('notification settings audit trail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records who pointed VC notifications at a channel', async () => {
    await handleVoiceSet(createInteraction());

    expect(set).toHaveBeenCalledWith('guild-1', 'voice', 'channel-1');
    expect(notifySetup).toHaveBeenCalledWith(
      expect.anything(),
      'guild-1',
      'mod-1',
      'channel-1',
      'Voice'
    );
  });

  it('records who pointed member-join notifications at a channel', async () => {
    await handleWelcomeSet(createInteraction());

    expect(set).toHaveBeenCalledWith('guild-1', 'member_join', 'channel-1');
    expect(notifySetup).toHaveBeenCalledWith(
      expect.anything(),
      'guild-1',
      'mod-1',
      'channel-1',
      'Welcome'
    );
  });

  it('records a disable that actually removed a configuration', async () => {
    remove.mockReturnValue(true);

    await handleVoiceRemove(createInteraction());

    expect(notifyRemove).toHaveBeenCalledWith(
      expect.anything(),
      'guild-1',
      'mod-1',
      'Voice'
    );
  });

  it('does not record a disable that changed nothing', async () => {
    remove.mockReturnValue(false);

    await handleWelcomeRemove(createInteraction());

    expect(notifyRemove).not.toHaveBeenCalled();
  });
});
