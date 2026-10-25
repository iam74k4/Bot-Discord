import { ChatInputCommandInteraction } from 'discord.js';
import { Command } from './command.js';

export interface MiddlewareResult {
  success: boolean;
  message?: string;
  /** Heading for a rejection; each middleware has its own default. */
  title?: string;
}

export type MiddlewareFunction = (
  interaction: ChatInputCommandInteraction,
  command: Command
) => Promise<MiddlewareResult>;

/**
 * Middleware registry maps names to handler functions.
 * Add new middleware by extending this interface.
 */
export interface MiddlewareRegistry {
  permissions: MiddlewareFunction;
  cooldown: MiddlewareFunction;
}

/**
 * Available middleware names, derived from the registry keys.
 * Adding a new entry to MiddlewareRegistry automatically extends this type.
 */
export type MiddlewareName = keyof MiddlewareRegistry;
