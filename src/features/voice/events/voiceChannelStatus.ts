import type { Event } from '../../../shared/types/index.js';
import { observeGatewayPacket } from '../application/voiceChannelStatus.js';

/**
 * Tracks voice channel statuses from raw gateway packets: discord.js does
 * not cache them, and the buffering notice must never overwrite one a
 * member set. Registered with the other events before login so the
 * `GUILD_CREATE` packets at startup are seen too.
 *
 * `raw` is emitted by discord.js but missing from its typed `ClientEvents`,
 * hence the cast.
 */
export const event = {
  name: 'raw',
  once: false,
  async execute(_client: unknown, packet: { t?: string | null; d?: unknown }) {
    observeGatewayPacket(packet);
  },
} as unknown as Event;
