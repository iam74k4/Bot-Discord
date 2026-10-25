import { Collection, SlashCommandBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  closestEntry,
  editDistance,
  getHelpIndex,
  MATCH_SCORE,
  MAX_QUERY_LENGTH,
  normalizeQuery,
  searchEntries,
  toSearchQuery,
} from '../application/helpIndex.js';
import type { Command } from '../../../shared/types/index.js';
import { helpCommand } from './general.helpers.js';

/**
 * The search behind `/general help`: how queries are folded, how a typo is
 * measured, and when help dares to guess.
 */

const DEMO = { en: 'Demo', ja: 'デモ' };

function indexOf(...commands: Command[]) {
  return getHelpIndex(
    new Collection(commands.map((command) => [command.data.name, command]))
  );
}

const record = helpCommand(
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('v')
    .addSubcommand((sub) =>
      sub
        .setName('record')
        .setDescription('Save audio')
        .setDescriptionLocalizations({ ja: '録音する' })
    ),
  { category: DEMO }
);

const everyone = () => true;

describe('normalizeQuery', () => {
  it.each([
    ['  Voice   RECORD ', 'voice record'],
    ['/voice record', 'voice record'],
    ['ｖｏｉｃｅ', 'voice'],
    ['録音', '録音'],
  ])('folds %j to %j', (input, expected) => {
    expect(normalizeQuery(input)).toBe(expected);
  });
});

describe('editDistance', () => {
  it.each([
    ['fun', 'fun', 0],
    ['fnu', 'fun', 1],
    ['recrod', 'record', 1],
    ['recor', 'record', 1],
    ['rec', 'record', 3],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['kitten', 'sitting', 3],
  ])('%j -> %j is %i', (a, b, expected) => {
    expect(editDistance(a, b)).toBe(expected);
    expect(editDistance(b, a)).toBe(expected);
  });
});

describe('closestEntry', () => {
  it('guesses the entry a typo was meant for', () => {
    expect(closestEntry(indexOf(record), 'recrod', everyone)?.entry.name).toBe(
      'voice record'
    );
  });

  it('does not guess from fewer than three characters', () => {
    expect(closestEntry(indexOf(record), 'vo', everyone)).toBeNull();
  });

  it('does not guess past two edits', () => {
    expect(closestEntry(indexOf(record), 'rexxrd', everyone)).not.toBeNull();
    expect(closestEntry(indexOf(record), 'rexxxd', everyone)).toBeNull();
  });

  it('never guesses an entry the asker may not see', () => {
    expect(closestEntry(indexOf(record), 'recrod', () => false)).toBeNull();
  });

  it('still guesses a name one letter longer or shorter', () => {
    expect(closestEntry(indexOf(record), 'recor', everyone)?.entry.name).toBe(
      'voice record'
    );
    expect(closestEntry(indexOf(record), 'recordd', everyone)?.entry.name).toBe(
      'voice record'
    );
  });

  it('makes no guess for a query far longer than any name', () => {
    expect(closestEntry(indexOf(record), 'q'.repeat(6000), everyone)).toBe(
      null
    );
    expect(closestEntry(indexOf(record), 'record'.repeat(1000), everyone)).toBe(
      null
    );
  });
});

describe('searchEntries', () => {
  it('matches a Japanese description and leaves hidden entries out', () => {
    const index = indexOf(record);

    expect(
      searchEntries(index, '録音', everyone).map((m) => m.indexed.entry.name)
    ).toEqual(['voice record']);
    expect(searchEntries(index, '録音', () => false)).toEqual([]);
  });

  it('ranks what an entry says above its command, and a note in parentheses last', () => {
    // `/notify voice` mentions 録音 only to say it is not about it; `/rec`
    // is about 録音, but only its top-level description says so.
    const notify = helpCommand(
      new SlashCommandBuilder()
        .setName('notify')
        .setDescription('n')
        .addSubcommand((sub) =>
          sub
            .setName('voice')
            .setDescription('Join notices (not recording)')
            .setDescriptionLocalizations({ ja: 'VC通知（録音ではありません）' })
        ),
      { category: DEMO }
    );
    const rec = helpCommand(
      new SlashCommandBuilder()
        .setName('rec')
        .setDescription('Recording tools')
        .setDescriptionLocalizations({ ja: '録音の道具' })
        .addSubcommand((sub) =>
          sub
            .setName('save')
            .setDescription('Save')
            .setDescriptionLocalizations({ ja: '保存' })
        ),
      { category: DEMO }
    );
    const index = indexOf(notify, rec, record);

    const ranked = (query: string) =>
      searchEntries(index, query, everyone).map((m) => [
        m.indexed.entry.name,
        m.score,
      ]);

    expect(ranked('録音')).toEqual([
      ['voice record', MATCH_SCORE.text],
      ['rec save', MATCH_SCORE.context],
      ['notify voice', MATCH_SCORE.aside],
    ]);
    expect(ranked('recording')).toEqual([
      ['rec save', MATCH_SCORE.context],
      ['notify voice', MATCH_SCORE.aside],
    ]);
  });

  it('ranks a category name with the command it belongs to', () => {
    const index = indexOf(record);

    expect(searchEntries(index, 'デモ', everyone).map((m) => m.score)).toEqual([
      MATCH_SCORE.context,
    ]);
  });

  it('ranks declared keywords like the entry’s own description', () => {
    const roulette = helpCommand(
      new SlashCommandBuilder()
        .setName('community')
        .setDescription('c')
        .addSubcommandGroup((group) =>
          group
            .setName('roulette')
            .setDescription('Pick people')
            .addSubcommand((sub) => sub.setName('team').setDescription('t'))
        ),
      {
        category: DEMO,
        keywords: { 'community roulette': [{ ja: 'ルーレット', en: 'wheel' }] },
      }
    );
    const index = indexOf(roulette);

    for (const query of ['ルーレット', 'Wheel']) {
      expect(
        searchEntries(index, query, everyone).map((m) => [
          m.indexed.entry.name,
          m.score,
        ])
      ).toEqual([['community roulette', MATCH_SCORE.text]]);
    }
  });

  it(`reads at most ${MAX_QUERY_LENGTH} characters of a query`, () => {
    const longest = 'a'.repeat(MAX_QUERY_LENGTH);
    const wordy = helpCommand(
      new SlashCommandBuilder()
        .setName('wordy')
        .setDescription('w')
        .addSubcommand((sub) => sub.setName('it').setDescription(longest)),
      { category: DEMO }
    );

    expect(toSearchQuery(`${longest}b`)).toBe(longest);
    expect(toSearchQuery('q'.repeat(6000))).toHaveLength(MAX_QUERY_LENGTH);
    // Only the first 100 characters are compared, so the extra `b` is not
    // there to stop the match.
    expect(
      searchEntries(indexOf(wordy), `${longest}b`, everyone).map(
        (m) => m.indexed.entry.name
      )
    ).toEqual(['wordy it']);
  });

  it('returns the same index for the same collection', () => {
    const commands = new Collection([['voice', record]]);

    expect(getHelpIndex(commands)).toBe(getHelpIndex(commands));
    expect(getHelpIndex(new Collection([['voice', record]]))).not.toBe(
      getHelpIndex(commands)
    );
  });
});
