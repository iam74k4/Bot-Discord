import { describe, expect, it } from 'vitest';
import { isGuildAllowed } from '../guildAllowlist.js';

describe('isGuildAllowed', () => {
  it('serves every server when no list is set (production)', () => {
    expect(isGuildAllowed('111111111111111111', [])).toBe(true);
  });

  it('serves only listed servers when a list is set', () => {
    const allowed = ['111111111111111111', '222222222222222222'];

    expect(isGuildAllowed('222222222222222222', allowed)).toBe(true);
    expect(isGuildAllowed('333333333333333333', allowed)).toBe(false);
  });

  it('always serves direct messages', () => {
    expect(isGuildAllowed(null, ['111111111111111111'])).toBe(true);
  });

  it('reads ALLOWED_GUILD_IDS from the loaded config by default', () => {
    // The test environment sets no list, so every server is served.
    expect(isGuildAllowed('333333333333333333')).toBe(true);
  });
});
