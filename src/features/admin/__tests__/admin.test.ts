import {
  ApplicationCommandOptionType,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/admin` is a thin router over two subcommand groups. Its schema is what
 * Discord shows users (and what gates it to Manage Server by default), so the
 * shape is pinned here together with the routing.
 */

vi.mock('../application/index.js', () => ({
  executeSettingsCommand: vi.fn(),
  executeRoleCommand: vi.fn(),
}));

const { command } = await import('../commands/admin.js');
const { executeRoleCommand, executeSettingsCommand } =
  await import('../application/index.js');

interface OptionJSON {
  name: string;
  name_localizations?: Record<string, string> | null;
  description?: string;
  description_localizations?: Record<string, string> | null;
  type: number;
  required?: boolean;
  channel_types?: number[];
  choices?: Array<{ name: string; value: string }>;
  options?: OptionJSON[];
}

const json = command.data.toJSON() as {
  name: string;
  default_member_permissions?: string | null;
  contexts?: number[] | null;
  options: OptionJSON[];
};

function group(name: string): OptionJSON {
  const found = json.options.find((o) => o.name === name);
  if (!found) throw new Error(`no subcommand group ${name}`);
  return found;
}

function subcommand(groupName: string, name: string): OptionJSON {
  const found = group(groupName).options?.find((o) => o.name === name);
  if (!found) throw new Error(`no subcommand ${groupName} ${name}`);
  return found;
}

function interactionFor(groupName: string | null) {
  return {
    options: { getSubcommandGroup: vi.fn(() => groupName) },
  } as unknown as ChatInputCommandInteraction;
}

describe('/admin command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('schema', () => {
    it('is hidden from members without Manage Server by default', () => {
      expect(json.name).toBe('admin');
      expect(json.default_member_permissions).toBe(
        PermissionFlagsBits.ManageGuild.toString()
      );
    });

    it('is offered only in servers, never in DMs', () => {
      expect(json.contexts).toEqual([InteractionContextType.Guild]);
    });

    it('names every option in Japanese for Japanese clients', () => {
      const named = (option: OptionJSON | undefined) => [
        option?.name,
        option?.name_localizations?.ja,
      ];
      expect(named(subcommand('settings', 'audit').options?.[0])).toEqual([
        'channel',
        'チャンネル',
      ]);
      expect(
        named(subcommand('settings', 'announcements').options?.[0])
      ).toEqual(['channel', 'チャンネル']);
      expect(named(subcommand('settings', 'language').options?.[0])).toEqual([
        'lang',
        '言語',
      ]);
      for (const name of ['add', 'remove']) {
        expect(subcommand('role', name).options?.map(named)).toEqual([
          ['user', 'メンバー'],
          ['role', 'ロール'],
        ]);
      }
    });

    it('explains what "automatic" means where the language is chosen', () => {
      const [lang] = subcommand('settings', 'language').options ?? [];
      expect(lang?.description_localizations?.ja).toContain('自動');
      expect(lang?.description?.toLowerCase()).toContain('automatic');
    });

    it('groups settings and role subcommands', () => {
      expect(
        json.options.map((o) => [o.name, o.type, o.options?.map((s) => s.name)])
      ).toEqual([
        [
          'settings',
          ApplicationCommandOptionType.SubcommandGroup,
          ['view', 'audit', 'announcements', 'logs', 'language'],
        ],
        [
          'role',
          ApplicationCommandOptionType.SubcommandGroup,
          ['add', 'remove'],
        ],
      ]);
    });

    it.each(['audit', 'announcements'])(
      'lets settings %s take an optional text channel (empty clears it)',
      (name) => {
        const [channel] = subcommand('settings', name).options ?? [];
        expect(channel).toMatchObject({
          name: 'channel',
          type: ApplicationCommandOptionType.Channel,
          channel_types: [ChannelType.GuildText],
        });
        expect(channel?.required ?? false).toBe(false);
      }
    );

    it('restricts settings language to the supported choices', () => {
      const [lang] = subcommand('settings', 'language').options ?? [];
      expect(lang).toMatchObject({
        name: 'lang',
        type: ApplicationCommandOptionType.String,
        required: true,
      });
      expect(lang?.choices?.map((c) => c.value)).toEqual(['en', 'ja', 'auto']);
    });

    it.each(['add', 'remove'])(
      'requires a user and a role for role %s',
      (name) => {
        expect(
          subcommand('role', name).options?.map((o) => [
            o.name,
            o.type,
            o.required,
          ])
        ).toEqual([
          ['user', ApplicationCommandOptionType.User, true],
          ['role', ApplicationCommandOptionType.Role, true],
        ]);
      }
    );

    it('lists both permissions it relies on in help', () => {
      expect(command.help?.permission).toEqual(['manageGuild', 'manageRoles']);
    });

    /**
     * Regression: help listed both groups to anyone holding either
     * permission, so a Manage Roles moderator was shown the settings group
     * and then refused by it.
     */
    it('lists each group in help only to the members it serves', () => {
      expect(command.help?.subcommandPermissions).toEqual({
        'admin settings': 'manageGuild',
        'admin role': 'manageRoles',
      });
    });
  });

  describe('routing', () => {
    it('sends settings subcommands to the settings handler', async () => {
      const interaction = interactionFor('settings');

      await command.execute(interaction);

      expect(executeSettingsCommand).toHaveBeenCalledWith(interaction);
      expect(executeRoleCommand).not.toHaveBeenCalled();
    });

    it('sends role subcommands to the role handler', async () => {
      const interaction = interactionFor('role');

      await command.execute(interaction);

      expect(executeRoleCommand).toHaveBeenCalledWith(interaction);
      expect(executeSettingsCommand).not.toHaveBeenCalled();
    });

    it.each([null, 'unknown'])('ignores group %j', async (groupName) => {
      await command.execute(interactionFor(groupName));

      expect(executeSettingsCommand).not.toHaveBeenCalled();
      expect(executeRoleCommand).not.toHaveBeenCalled();
    });
  });
});
