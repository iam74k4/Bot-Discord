import { VoiceConnection } from '@discordjs/voice';
import { Snowflake } from 'discord.js';

/**
 * Voice connection state
 */
export enum VoiceConnectionState {
  Connecting = 'connecting',
  Connected = 'connected',
  Disconnecting = 'disconnecting',
  Disconnected = 'disconnected',
  Error = 'error',
}

/**
 * Recording options
 */
export interface RecordingOptions {
  /** Duration in seconds */
  duration: number;
  /** Channel ID where the recording is requested */
  channelId: Snowflake;
  /** User ID who requested the recording */
  userId: Snowflake;
  /** Guild ID */
  guildId: Snowflake;
  /**
   * Largest file Discord accepts from this interaction, in bytes
   * (`interaction.attachmentSizeLimit`). Recordings that would not fit are
   * split into equal, sample-aligned parts below it. Defaults to
   * `DISCORD_LIMITS.FALLBACK_ATTACHMENT_BYTES`.
   */
  maxUploadBytes?: number;
}

/**
 * One WAV file of a recording.
 */
export interface RecordingPart {
  /** Where the retention copy was written */
  filePath: string;
  /** Size of the WAV file in bytes, header included */
  size: number;
  /**
   * The same WAV in memory, so delivery does not read the file back from
   * disk (and again on every retry).
   */
  data: Buffer;
  /** Offset of the part's first sample from the start of the clip, in seconds */
  startSeconds: number;
  /** Offset just past the part's last sample, in seconds */
  endSeconds: number;
}

/**
 * Recording result
 */
export interface RecordingResult {
  /** File path of the first (or only) part */
  filePath: string;
  /** Total size of every part in bytes */
  fileSize: number;
  /**
   * Seconds actually saved. Shorter than requested when the bot has not
   * been hearing the channel for that long yet.
   */
  duration: number;
  /** Seconds that were asked for */
  requestedDuration?: number;
  /** Whether the recording was split into several files */
  isSplit: boolean;
  /** File paths of parts 2..n when split */
  additionalFiles?: string[];
  /** Every part in order, with its bytes */
  parts?: RecordingPart[];
}

/**
 * Voice connection info
 */
export interface VoiceConnectionInfo {
  /** Voice connection instance */
  connection: VoiceConnection;
  /** Connection state */
  state: VoiceConnectionState;
  /** Channel ID */
  channelId: Snowflake;
  /** Guild ID */
  guildId: Snowflake;
  /** Connected at timestamp */
  connectedAt: number;
  /** Last activity timestamp */
  lastActivity: number;
  /** Whether audio is received at all (false = deafened, TTS-only join) */
  receiving?: boolean;
  /**
   * Whether received audio goes into the record buffer. False for a join
   * that listens only for captions; absent means the same as `receiving`.
   */
  buffering?: boolean;
}

/**
 * Memory monitor stats
 */
export interface MemoryMonitorStats {
  /** Resident set size in MB (includes off-heap mix ring buffers) */
  memoryUsageMB: number;
  /** V8 heap usage in MB (context only; not the shed-load trigger) */
  heapUsedMB: number;
  /** Configured memory budget in MB (MEMORY_LIMIT_MB) */
  limitMB: number;
  /** Active voice connections count */
  activeConnections: number;
  /** Total buffer size in MB */
  totalBufferSizeMB: number;
}
