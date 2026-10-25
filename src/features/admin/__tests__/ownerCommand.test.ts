import {
  ApplicationCommandOptionType,
  InteractionContextType,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * `/owner` is for the bot operator only. Who may run it is decided against
 * BOT_OWNER_IDS at runtime (see owner.test.ts); the schema decides who is
 * even shown it, which is what is pinned here.
 */

vi.mock('../application/owner.js', () => ({
  executeOwnerCommand: vi.fn(),
}));

const { command } = await import('../commands/owner.js');
const { executeOwnerCommand } = await import('../application/owner.js');

interface OptionJSON {
  name: string;
  type: number;
  description: string;
  description_localizations?: Record<string, string> | null;
  name_localizations?: Record<string, string> | null;
  options?: OptionJSON[];
}

const json = command.data.toJSON() as {
  name: string;
  default_member_permissions?: string | null;
  contexts?: number[] | null;
  options: OptionJSON[];
};

function subcommand(group: string, name: string): OptionJSON {
  const found = json.options
    .find((option) => option.name === group)
    ?.options?.find((option) => option.name === name);
  if (!found) throw new Error(`no subcommand ${group} ${name}`);
  return found;
}

describe('/owner command', () => {
  /**
   * Regression: with no default permission, every member of every server
   * saw /owner in the picker, only to be refused.
   */
  it('is hidden from everyone but server admins in servers', () => {
    expect(json.default_member_permissions).toBe('0');
  });

  it("is offered in servers and the bot's DM, not in other DMs", () => {
    expect(json.contexts).toEqual([
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
    ]);
  });

  it('describes broadcast as what it does: post to opted-in channels', () => {
    const broadcast = subcommand('system', 'broadcast');
    expect(broadcast.description).toContain('announcement channel');
    expect(broadcast.description_localizations?.ja).toContain(
      'お知らせチャンネル'
    );
    expect(broadcast.description).not.toContain('owners');
    const [message] = broadcast.options ?? [];
    expect(message).toMatchObject({
      name: 'message',
      type: ApplicationCommandOptionType.String,
      name_localizations: { ja: 'メッセージ' },
    });
  });

  it('stays listed in help for the owner only', () => {
    expect(command.help?.permission).toBe('owner');
  });

  it('hands every invocation to the owner application', async () => {
    const interaction = {} as ChatInputCommandInteraction;

    await command.execute(interaction);

    expect(executeOwnerCommand).toHaveBeenCalledWith(interaction);
  });
});
