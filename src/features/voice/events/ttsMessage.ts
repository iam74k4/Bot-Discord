import { Events, Message } from 'discord.js';
import { Event } from '../../../shared/types/index.js';
import { ExtendedClient } from '../../../client.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { handleTtsMessage } from '../application/tts.js';

/**
 * Feed chat into text-to-speech. Only fires when the client was created with
 * the Message Content intent, which happens when VOICEVOX_URL is set.
 */
export const event: Event<typeof Events.MessageCreate> = {
  name: Events.MessageCreate,
  once: false,
  async execute(client: ExtendedClient, message: Message) {
    if (!client.isFullyReady) return;
    try {
      await handleTtsMessage(message);
    } catch (error) {
      logger.error('TTS message handling failed:', getErrorMessage(error));
    }
  },
};
