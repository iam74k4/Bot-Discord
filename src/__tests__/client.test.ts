import { Collection, GatewayIntentBits, IntentsBitField } from 'discord.js';
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
