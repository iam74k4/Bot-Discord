import type { Client } from 'discord.js';
import { ChannelType } from 'discord.js';
import { voiceSessionRepository } from '../repositories/voiceSessionRepository.js';
import { logger } from '../../../shared/utils/logger.js';

interface ActiveSession {
  sessionId: number;
  channelId: string;
  /** Name when the session started, for stats when the channel is uncached. */
  channelName: string;
  joinedAt: number;
}

const activeSessions = new Map<string, ActiveSession>();

function makeKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function startSession(
  guildId: string,
  userId: string,
  channelId: string,
  channelName: string
): void {
  const key = makeKey(guildId, userId);

  if (activeSessions.has(key)) {
    endSession(guildId, userId);
  }

  const sessionId = voiceSessionRepository.startSession(
    guildId,
    userId,
    channelId,
    channelName
  );

  activeSessions.set(key, {
    sessionId,
    channelId,
    channelName,
    joinedAt: Date.now(),
  });

  logger.debug(
    `Voice session started: user=${userId} channel=${channelId} session=${sessionId}`
  );
}

function endSession(guildId: string, userId: string): void {
  const key = makeKey(guildId, userId);
  const session = activeSessions.get(key);

  if (!session) return;

  voiceSessionRepository.endSession(session.sessionId);
  activeSessions.delete(key);

  logger.debug(
    `Voice session ended: user=${userId} session=${session.sessionId}`
  );
}

function getActiveSession(
  guildId: string,
  userId: string
): ActiveSession | undefined {
  return activeSessions.get(makeKey(guildId, userId));
}

function closeAllStaleSessions(): void {
  const closed = voiceSessionRepository.closeAllStaleSessions();
  if (closed > 0) {
    logger.info(`Closed ${closed} stale voice session(s) from previous run`);
  }
  activeSessions.clear();
}

/**
 * Close every in-memory session at graceful shutdown so downtime is not
 * attributed to users who were connected when the process stopped.
 */
function endAllSessions(): void {
  for (const key of [...activeSessions.keys()]) {
    const separator = key.indexOf(':');
    if (separator <= 0) continue;
    const guildId = key.slice(0, separator);
    const userId = key.slice(separator + 1);
    endSession(guildId, userId);
  }
}

/**
 * Restart does not emit join events for users already in VC. Re-open sessions
 * for current occupants so post-restart presence is tracked.
 */
function reconcileActiveVoiceSessions(client: Client): void {
  let started = 0;

  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (
        channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildStageVoice
      ) {
        continue;
      }
      // Idle members parked in the AFK channel are not counted as in VC,
      // matching what the live voice-state handler does.
      if (channel.id === guild.afkChannelId) continue;

      if (!('members' in channel) || !channel.members) continue;

      for (const member of channel.members.values()) {
        if (member.user.bot) continue;
        if (getActiveSession(guild.id, member.id)) continue;
        startSession(guild.id, member.id, channel.id, channel.name);
        started++;
      }
    }
  }

  if (started > 0) {
    logger.info(`Reconciled ${started} active voice session(s) after restart`);
  }
}

export const voiceTracker = {
  startSession,
  endSession,
  endAllSessions,
  getActiveSession,
  closeAllStaleSessions,
  reconcileActiveVoiceSessions,
};
