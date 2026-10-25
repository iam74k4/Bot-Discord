/**
 * Collapse a burst of voice-state changes into what actually happened.
 *
 * Announcing every join and leave separately turns an ordinary "everyone
 * piles into the call" moment into a wall of embeds, and a single user moving
 * between channels always cost two messages. Reducing a window of raw events
 * to a per-user net effect fixes both: a move becomes one line, and someone
 * who joined and left again inside the window disappears entirely - they are
 * neither in the channel now nor were they before.
 */

export interface VoiceActivity {
  userId: string;
  displayName: string;
  channelId: string;
  kind: 'join' | 'leave';
}

export interface VoiceDigestEntry {
  displayName: string;
  channelId: string;
}

export interface VoiceMoveEntry {
  displayName: string;
  fromChannelId: string;
  toChannelId: string;
}

export interface VoiceDigest {
  joined: VoiceDigestEntry[];
  left: VoiceDigestEntry[];
  moved: VoiceMoveEntry[];
}

/**
 * Per-user net effect over the window.
 *
 * `from` is the channel they were in when the window opened and have since
 * left; `to` is the channel they are in now. Both set means a move, one set
 * means a plain join or leave, neither means the visit cancelled itself out.
 * The same channel on both ends (a reconnect, or a hop that came back) also
 * cancels out: nothing changed for anyone reading the channel.
 */
interface NetEffect {
  displayName: string;
  from?: string;
  to?: string;
}

export function summarizeVoiceActivity(
  events: readonly VoiceActivity[]
): VoiceDigest {
  // Insertion order is preserved so the digest reads in the order things
  // happened rather than in hash order.
  const effects = new Map<string, NetEffect>();

  for (const event of events) {
    const effect = effects.get(event.userId) ?? {
      displayName: event.displayName,
    };
    effect.displayName = event.displayName;

    if (event.kind === 'join') {
      effect.to = event.channelId;
    } else if (effect.to === event.channelId) {
      // Leaving the same channel they joined during this window.
      effect.to = undefined;
    } else {
      effect.from ??= event.channelId;
    }

    effects.set(event.userId, effect);
  }

  const digest: VoiceDigest = { joined: [], left: [], moved: [] };

  for (const { displayName, from, to } of effects.values()) {
    if (from && from === to) continue;
    if (from && to) {
      digest.moved.push({ displayName, fromChannelId: from, toChannelId: to });
    } else if (to) {
      digest.joined.push({ displayName, channelId: to });
    } else if (from) {
      digest.left.push({ displayName, channelId: from });
    }
  }

  return digest;
}

export function isVoiceDigestEmpty(digest: VoiceDigest): boolean {
  return (
    digest.joined.length === 0 &&
    digest.left.length === 0 &&
    digest.moved.length === 0
  );
}
