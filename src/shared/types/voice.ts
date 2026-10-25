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
}

/**
 * Recording result
 */
export interface RecordingResult {
  /** File path of the recorded audio */
  filePath: string;
  /** File size in bytes */
  fileSize: number;
  /** Duration in seconds */
  duration: number;
  /** Whether the file was split */
  isSplit: boolean;
  /** Additional file paths if split */
  additionalFiles?: string[];
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
  /** Whether audio is decoded into the record buffer (false = TTS-only join) */
  receiving?: boolean;
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
