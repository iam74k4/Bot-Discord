import {
  Collection,
  GatewayIntentBits,
  GuildMemberManager,
  IntentsBitField,
  LimitedCollection,
  Message,
  MessageManager,
  GuildMember,
} from 'discord.js';
import { Agent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, ExtendedClient, REST_KEEP_ALIVE_MS } from '../client.js';

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

describe('caches', () => {
  afterEach(async () => {
    for (const client of created.splice(0)) await client.destroy();
  });

  /** The cache the client would build for a manager. */
  function cacheFor(
    client: ExtendedClient,
    manager: unknown,
    holds: unknown
  ): Collection<unknown, unknown> {
    const makeCache = client.options.makeCache as unknown as (
      managerType: unknown,
      holds: unknown,
      manager: unknown
    ) => Collection<unknown, unknown>;
    return makeCache(manager, holds, manager);
  }

  it('keeps no chat messages once the message intents are on', () => {
    const cache = cacheFor(
      make({ messageContent: true }),
      MessageManager,
      Message
    );

    expect(cache).toBeInstanceOf(LimitedCollection);
    expect((cache as LimitedCollection<unknown, unknown>).maxSize).toBe(0);
    cache.set('1', {});
    expect(cache.size).toBe(0);
  });

  it('leaves member caches unlimited: text-to-speech resolves names from them', () => {
    const cache = cacheFor(
      make({ messageContent: true }),
      GuildMemberManager,
      GuildMember
    );

    expect(cache).not.toBeInstanceOf(LimitedCollection);
  });

  it('keeps discord.js defaults without the message intents', () => {
    const cache = cacheFor(make(), MessageManager, Message);

    expect((cache as LimitedCollection<unknown, unknown>).maxSize).toBe(200);
  });
});

describe('REST connection pool', () => {
  it('keeps idle API connections open for 30 seconds', async () => {
    const client = make();

    expect(REST_KEEP_ALIVE_MS).toBe(30_000);
    expect(client.restAgent).toBeInstanceOf(Agent);
    // The REST client sends every request through this pool.
    expect((client.rest as unknown as { agent: unknown }).agent).toBe(
      client.restAgent
    );
    await client.destroy();
    created.splice(created.indexOf(client), 1);
  });

  it('closes the pool when the client is destroyed, even if destroy fails', async () => {
    const client = createClient();
    expect(client.restAgent.closed).toBe(false);

    await client.destroy();
    expect(client.restAgent.closed).toBe(true);

    const failing = createClient();
    vi.spyOn(
      Object.getPrototypeOf(ExtendedClient.prototype) as {
        destroy(): Promise<void>;
      },
      'destroy'
    ).mockRejectedValueOnce(new Error('gateway hung'));

    await expect(failing.destroy()).rejects.toThrow('gateway hung');
    expect(failing.restAgent.closed).toBe(true);
  });
});
