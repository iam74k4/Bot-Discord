import { describe, expect, it } from 'vitest';
import {
  collectAnswers,
  MAX_ANSWER_LENGTH,
  parseAnswerLines,
} from '../poll/application.js';

/**
 * Discord rejects a malformed poll with an opaque API error, so the answers
 * are validated here first and the reply names what is wrong.
 */
function options(values: Array<string | null>) {
  return (index: number) => values[index - 1] ?? null;
}

describe('collectAnswers', () => {
  it('keeps the options that were filled in, in order', () => {
    const result = collectAnswers(options(['Ramen', 'Curry', 'Sushi']));

    expect(result).toEqual({
      answers: [{ text: 'Ramen' }, { text: 'Curry' }, { text: 'Sushi' }],
    });
  });

  it('skips gaps left by unused option slots', () => {
    const result = collectAnswers(options(['Ramen', null, 'Sushi']));

    expect(result).toEqual({
      answers: [{ text: 'Ramen' }, { text: 'Sushi' }],
    });
  });

  it('refuses a poll with fewer than two answers', () => {
    expect(collectAnswers(options(['Ramen']))).toEqual({
      error: 'notEnough',
    });
  });

  it("refuses an answer longer than Discord's limit", () => {
    const tooLong = 'x'.repeat(MAX_ANSWER_LENGTH + 1);

    expect(collectAnswers(options(['Ramen', tooLong]))).toEqual({
      error: 'tooLong',
    });
  });

  it('reads exactly the ten option slots the command offers', () => {
    const asked: number[] = [];
    collectAnswers((index) => {
      asked.push(index);
      return `Choice ${index}`;
    });

    expect(asked).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('treats an empty string like an unused slot', () => {
    expect(collectAnswers(options(['Ramen', '']))).toEqual({
      error: 'notEnough',
    });
  });

  it('reports an over-long answer even when too few are filled in', () => {
    expect(
      collectAnswers(options(['x'.repeat(MAX_ANSWER_LENGTH + 1)]))
    ).toEqual({ error: 'tooLong' });
  });

  it('accepts an answer exactly at the limit', () => {
    const exact = 'x'.repeat(MAX_ANSWER_LENGTH);

    expect(collectAnswers(options(['Ramen', exact]))).toEqual({
      answers: [{ text: 'Ramen' }, { text: exact }],
    });
  });
});

describe('parseAnswerLines', () => {
  it('reads one answer per line, trimmed, in order', () => {
    expect(parseAnswerLines('  Ramen\nCurry  \nSushi')).toEqual({
      answers: [{ text: 'Ramen' }, { text: 'Curry' }, { text: 'Sushi' }],
    });
  });

  it('accepts Windows line breaks', () => {
    expect(parseAnswerLines('Ramen\r\nCurry\r\n')).toEqual({
      answers: [{ text: 'Ramen' }, { text: 'Curry' }],
    });
  });

  it('drops blank lines and repeated answers', () => {
    expect(parseAnswerLines('Ramen\n\n   \nCurry\nRamen\n')).toEqual({
      answers: [{ text: 'Ramen' }, { text: 'Curry' }],
    });
  });

  it('names the line of an over-long answer, counting blank lines', () => {
    const tooLong = 'x'.repeat(MAX_ANSWER_LENGTH + 1);

    expect(parseAnswerLines(`Ramen\n\n${tooLong}\nCurry`)).toEqual({
      error: 'lineTooLong',
      line: 3,
      length: MAX_ANSWER_LENGTH + 1,
    });
  });

  it('measures an answer after trimming it', () => {
    const exact = 'x'.repeat(MAX_ANSWER_LENGTH);

    expect(parseAnswerLines(`  ${exact}  \nRamen`)).toEqual({
      answers: [{ text: exact }, { text: 'Ramen' }],
    });
  });

  it('accepts exactly ten answers and refuses eleven, saying how many', () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `Choice ${i + 1}`).join('\n');

    expect(parseAnswerLines(lines(10))).toHaveProperty('answers');
    expect(parseAnswerLines(lines(11))).toEqual({
      error: 'tooMany',
      count: 11,
    });
  });

  it('counts only distinct answers towards the limit', () => {
    const text = [...Array(10).keys(), 0, 1].map((i) => `c${i}`).join('\n');

    expect(parseAnswerLines(text)).toHaveProperty('answers');
  });

  it.each([
    ['nothing', ''],
    ['one answer', 'Ramen'],
    ['one answer twice', 'Ramen\nRamen'],
  ])('refuses %s as too few', (_, text) => {
    expect(parseAnswerLines(text)).toEqual({ error: 'notEnough' });
  });
});
