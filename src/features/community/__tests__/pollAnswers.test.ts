import { describe, expect, it } from 'vitest';
import { collectAnswers, MAX_ANSWER_LENGTH } from '../poll/application.js';

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
