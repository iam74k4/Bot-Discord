import { afterEach, describe, expect, it } from 'vitest';
import { InteractionType } from 'discord.js';
import {
  clearCommandIds,
  commandMention,
  commandPathOf,
  getCommandId,
  originCommandPathOf,
  setCommandIds,
} from '../commandMentions.js';

afterEach(() => {
  clearCommandIds();
});

describe('commandMention', () => {
  it('falls back to a code span while the ids are unknown', () => {
    expect(commandMention('voice record')).toBe('`/voice record`');
  });

  it('renders a clickable mention once the top-level id is known', () => {
    setCommandIds([
      { name: 'voice', id: '111' },
      { name: 'admin', id: '222' },
    ]);

    expect(commandMention('voice record')).toBe('</voice record:111>');
    expect(commandMention('admin settings view')).toBe(
      '</admin settings view:222>'
    );
    expect(commandMention('voice')).toBe('</voice:111>');
  });

  it('keeps the fallback for a command Discord did not report', () => {
    setCommandIds([{ name: 'voice', id: '111' }]);

    expect(commandMention('tts start')).toBe('`/tts start`');
  });

  it('accepts a leading slash and stray whitespace', () => {
    setCommandIds([{ name: 'voice', id: '111' }]);

    expect(commandMention('/voice  autojoin exclude ')).toBe(
      '</voice autojoin exclude:111>'
    );
    clearCommandIds();
    expect(commandMention(' /voice record')).toBe('`/voice record`');
  });

  it('replaces the whole id set on every registration', () => {
    setCommandIds([{ name: 'voice', id: '111' }]);
    setCommandIds([{ name: 'admin', id: '222' }]);

    expect(getCommandId('voice')).toBeUndefined();
    expect(getCommandId('admin')).toBe('222');
  });

  it('ignores entries without a name or id', () => {
    setCommandIds([
      { name: '', id: '1' },
      { name: 'voice', id: '' },
    ]);

    expect(commandMention('voice record')).toBe('`/voice record`');
  });
});

describe('commandPathOf', () => {
  function interaction(group: string | null, sub: string | null) {
    return {
      commandName: 'voice',
      options: {
        getSubcommandGroup: (required: boolean) => {
          expect(required).toBe(false);
          return group;
        },
        getSubcommand: (required: boolean) => {
          expect(required).toBe(false);
          return sub;
        },
      },
    };
  }

  it.each([
    [null, null, 'voice'],
    [null, 'record', 'voice record'],
    ['autojoin', 'exclude', 'voice autojoin exclude'],
  ])('group %s + subcommand %s -> %s', (group, sub, expected) => {
    expect(commandPathOf(interaction(group, sub))).toBe(expected);
  });

  it('falls back to the command name without an options resolver', () => {
    expect(commandPathOf({ commandName: 'ping' })).toBe('ping');
    expect(commandPathOf({ commandName: 'ping', options: {} })).toBe('ping');
  });

  it('is empty without a command name', () => {
    expect(
      commandPathOf({ ...interaction(null, 'record'), commandName: '' })
    ).toBe('');
  });

  it('survives a resolver that throws', () => {
    expect(
      commandPathOf({
        commandName: 'ping',
        options: {
          getSubcommand: () => {
            throw new Error('no subcommand');
          },
        },
      })
    ).toBe('ping');
  });
});

describe('originCommandPathOf', () => {
  const replyTo = (type: InteractionType, commandName: unknown) => ({
    interaction: { type, commandName },
  });

  it('names the slash command, with subcommands, that a message replied to', () => {
    expect(
      originCommandPathOf(
        replyTo(InteractionType.ApplicationCommand, 'admin settings view')
      )
    ).toBe('admin settings view');
  });

  it('ignores the reply to a button press, whose name is a customId', () => {
    expect(
      originCommandPathOf(
        replyTo(InteractionType.MessageComponent, 'admin-panel:backup')
      )
    ).toBe('');
  });

  it('is empty for a message that replied to nothing, or a missing message', () => {
    expect(originCommandPathOf({ interaction: null })).toBe('');
    expect(originCommandPathOf({})).toBe('');
    expect(originCommandPathOf(null)).toBe('');
    expect(originCommandPathOf(undefined)).toBe('');
    expect(
      originCommandPathOf(replyTo(InteractionType.ApplicationCommand, 42))
    ).toBe('');
  });
});
