import type { FeatureContext } from '../index.js';
import { MemoryMonitor } from './jobs/memoryMonitor.js';
import { FileCleanupService } from './jobs/fileCleanup.js';
import {
  connectionManager,
  logOpusBackend,
} from './recording/connectionManager.js';
import { reconcileOccupiedVoiceChannels } from './application/reconcile.js';
import { forgetAnnouncement, OPT_OUT_PREFIX } from './application/announce.js';
import { handleOptOutClick } from './application/optOut.js';
import { warmUpTts } from './application/tts.js';
import { voiceSettingsSummary } from './application/settingsSummary.js';
import {
  clearStaleBufferingStatuses,
  settleBufferingStatus,
} from './application/voiceChannelStatus.js';
import { ttsSessions } from './tts/sessionManager.js';
import { setServiceStatus } from '../../infrastructure/health/index.js';
import { registerComponentHandler } from '../../shared/interactions/index.js';
import { registerSettingsSummary } from '../../shared/settingsSummary/index.js';

export const name = 'voice';

/**
 * Both jobs are built from the configuration this feature is started with,
 * not at import time: constructing them on import made merely importing the
 * module read and validate the environment.
 */
let memoryMonitor: MemoryMonitor | null = null;
let fileCleanupService: FileCleanupService | null = null;
let unsubscribeTts: (() => void) | null = null;
let unregisterOptOut: (() => void) | null = null;
let unhookStatus: (() => void) | null = null;
let unregisterSummary: (() => void) | null = null;

/**
 * Start Voice jobs and recording runtime
 */
export async function start({ client, config }: FeatureContext): Promise<void> {
  // Whether the opusscript decoder cap applies, visible before anyone speaks.
  logOpusBackend();

  memoryMonitor = new MemoryMonitor(config);
  memoryMonitor.start();
  setServiceStatus('voiceMemoryMonitor', true);

  fileCleanupService = new FileCleanupService(config);
  fileCleanupService.start();
  setServiceStatus('voiceFileCleanup', true);

  // A reading session cannot outlive the connection it plays through.
  unsubscribeTts = connectionManager.onDisconnect((channelId) =>
    ttsSessions.handleDisconnect(channelId)
  );

  // The bot's "keeping audio" voice channel status is cleared before each
  // leave, while Discord still accepts it from the bot.
  unhookStatus?.();
  unhookStatus = connectionManager.onBeforeDisconnect((channelId) =>
    settleBufferingStatus(channelId, client)
  );
  // Statuses left behind by an earlier run (a crash, say), where allowed.
  void clearStaleBufferingStatuses(client);

  // The "exclude this channel" button on buffering notices, including
  // notices posted before this process started.
  unregisterOptOut?.();
  unregisterOptOut = registerComponentHandler(
    OPT_OUT_PREFIX,
    handleOptOutClick
  );

  // Auto-join and exclusions in the /admin settings overview.
  unregisterSummary?.();
  unregisterSummary = registerSettingsSummary('voice', voiceSettingsSummary, {
    order: 30,
  });

  // The VOICEVOX voice list and default model, so the first /tts line and
  // speaker autocomplete do not pay for a cold engine. Never throws.
  warmUpTts();

  await reconcileOccupiedVoiceChannels(client);
}

/**
 * Stop Voice jobs and recording runtime
 */
export async function stop(): Promise<void> {
  unregisterOptOut?.();
  unregisterOptOut = null;
  unregisterSummary?.();
  unregisterSummary = null;

  fileCleanupService?.stop();
  fileCleanupService = null;
  setServiceStatus('voiceFileCleanup', false);

  memoryMonitor?.stop();
  memoryMonitor = null;
  setServiceStatus('voiceMemoryMonitor', false);

  ttsSessions.stopAll();
  unsubscribeTts?.();
  unsubscribeTts = null;

  for (const [channelId] of connectionManager.getAllConnections()) {
    // Starts clearing the voice channel status the bot set; the disconnect
    // waits (briefly) for that while the bot is still in the channel.
    forgetAnnouncement(channelId);
    await connectionManager.disconnect(channelId);
  }
  unhookStatus?.();
  unhookStatus = null;
}
