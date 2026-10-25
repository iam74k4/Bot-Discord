import {
  ChannelType,
  Collection,
  GatewayIntentBits,
  type Guild,
  GuildMemberManager,
  IntentsBitField,
  type Message,
  MessageManager,
  type TextChannel,
} from 'discord.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient, ExtendedClient } from '../client.js';

/**
 * Message Content is privileged: requesting it without enabling it in the
 * Developer Portal makes the gateway refuse the login. It must only be asked
 * for when text-to-speech needs it.
 */
const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildVoiceStates,
];

const created: ExtendedClient[] = [];

function make(...args: Parameters<typeof createClient>): ExtendedClient {
  const client = createClient(...args);
  created.push(client);
  return client;
}

function intentsOf(client: ExtendedClient): IntentsBitField {
  return new IntentsBitField(client.options.intents);
}

describe('createClient', () => {
  afterEach(async () => {
    for (const client of created.splice(0)) await client.destroy();
  });

  it('returns an ExtendedClient with an empty command registry', () => {
    const client = make();
    expect(client).toBeInstanceOf(ExtendedClient);
    expect(client.commands).toBeInstanceOf(Collection);
    expect(client.commands.size).toBe(0);
    expect(client.isFullyReady).toBe(false);
  });

  it.each([
    ['no options', undefined],
    ['an empty options object', {}],
    ['messageContent: false', { messageContent: false }],
  ])('requests only the base intents with %s', (_label, options) => {
    const intents = intentsOf(make(options));

    for (const intent of BASE_INTENTS) {
      expect(intents.has(intent)).toBe(true);
    }
    expect(intents.has(GatewayIntentBits.MessageContent)).toBe(false);
    expect(intents.has(GatewayIntentBits.GuildMessages)).toBe(false);
    expect(intents.bitfield).toBe(new IntentsBitField(BASE_INTENTS).bitfield);
  });

  it('adds Message Content and Guild Messages when asked', () => {
    const intents = intentsOf(make({ messageContent: true }));

    for (const intent of BASE_INTENTS) {
      expect(intents.has(intent)).toBe(true);
    }
    expect(intents.has(GatewayIntentBits.MessageContent)).toBe(true);
    expect(intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
    expect(intents.bitfield).toBe(
      new IntentsBitField([
        ...BASE_INTENTS,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ]).bitfield
    );
  });
});

describe('message cache', () => {
  afterEach(async () => {
    for (const client of created.splice(0)) await client.destroy();
  });

  /** The cache discord.js would build for a manager, with its size cap. */
  function cacheFor(
    client: ExtendedClient,
    manager: typeof MessageManager | typeof GuildMemberManager
  ): { constructor: unknown; maxSize?: number } {
    return client.options.makeCache!(
      manager as never,
      Object as never,
      manager as never
    ) as unknown as { constructor: unknown; maxSize?: number };
  }

  const messageCacheOf = (client: ExtendedClient) =>
    cacheFor(client, MessageManager);

  /** discord.js's internal hooks the gateway uses to fill its caches. */
  interface Internals {
    guilds: { _add(data: unknown): Guild };
    channels: { _add(data: unknown, guild: Guild): unknown };
    actions: { MessageCreate: { handle(data: unknown): void } };
  }

  it('keeps no messages when guild messages are received', () => {
    expect(messageCacheOf(make({ messageContent: true })).maxSize).toBe(0);
  });

  it('keeps the discord.js defaults otherwise', () => {
    expect(messageCacheOf(make()).maxSize).toBe(200);
  });

  it('leaves the other caches at their defaults', () => {
    const tuned = cacheFor(make({ messageContent: true }), GuildMemberManager);
    const stock = cacheFor(make(), GuildMemberManager);
    expect(tuned.constructor).toBe(stock.constructor);
    expect(tuned.maxSize).toBe(stock.maxSize);
  });

  it('still delivers each message in full while caching none', () => {
    const client = make({ messageContent: true });
    const internals = client as unknown as Internals;
    const guild = internals.guilds._add({
      id: '100',
      name: 'Guild',
      channels: [],
      members: [],
      roles: [],
    });
    const channel = internals.channels._add(
      {
        id: '200',
        type: ChannelType.GuildText,
        name: 'chat',
        guild_id: '100',
      },
      guild
    ) as TextChannel;

    const received: Message[] = [];
    client.on('messageCreate', (message) => received.push(message));
    for (let i = 0; i < 3; i++) {
      internals.actions.MessageCreate.handle({
        id: String(300 + i),
        channel_id: '200',
        guild_id: '100',
        content: `hello ${i}`,
        author: { id: '400', username: 'member', discriminator: '0' },
        type: 0,
        timestamp: new Date(0).toISOString(),
        attachments: [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        pinned: false,
        tts: false,
      });
    }

    expect(received.map((message) => message.content)).toEqual([
      'hello 0',
      'hello 1',
      'hello 2',
    ]);
    expect(channel.messages.cache.size).toBe(0);
  });
});
