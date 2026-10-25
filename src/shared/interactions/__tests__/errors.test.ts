import { describe, expect, it } from 'vitest';
import { createErrorId, describeError } from '../errors.js';

describe('createErrorId', () => {
  it('is six lowercase hex characters, different each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createErrorId()));

    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{6}$/);
    expect(ids.size).toBeGreaterThan(45);
  });
});

describe('describeError', () => {
  it('prefers the stack, which starts with the message', () => {
    const error = new Error('boom');

    expect(describeError(error)).toBe(error.stack);
    expect(describeError(error)).toContain('boom');
  });

  it('falls back to the message when there is no stack', () => {
    const error = new Error('no stack');
    error.stack = undefined;

    expect(describeError(error)).toBe('no stack');
    expect(describeError('plain')).toBe('plain');
    expect(describeError(404)).toBe('404');
  });
});
