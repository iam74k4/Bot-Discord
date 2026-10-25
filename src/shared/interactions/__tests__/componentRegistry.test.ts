import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearComponentHandlers,
  findComponentHandler,
  isComponentRoutingReady,
  registerComponentHandler,
  setComponentRoutingReady,
} from '../componentRegistry.js';

afterEach(() => {
  clearComponentHandlers();
});

describe('persistent component registry', () => {
  it('routes a customId to the handler registered for its prefix', () => {
    const handle = vi.fn();
    registerComponentHandler('voice-optout:', handle);

    expect(findComponentHandler('voice-optout:123')?.handle).toBe(handle);
    expect(findComponentHandler('voice-optout:')?.handle).toBe(handle);
  });

  it('finds nothing for an unregistered or merely similar customId', () => {
    registerComponentHandler('voice-optout:', vi.fn());

    expect(findComponentHandler('settings-panel:audit')).toBeUndefined();
    expect(findComponentHandler('voice-optou')).toBeUndefined();
  });

  it('prefers the longest matching prefix', () => {
    const broad = vi.fn();
    const narrow = vi.fn();
    registerComponentHandler('voice:', broad);
    registerComponentHandler('voice:optout:', narrow);

    expect(findComponentHandler('voice:optout:1')?.handle).toBe(narrow);
    expect(findComponentHandler('voice:other')?.handle).toBe(broad);
  });

  it('refuses an empty prefix and a duplicate registration', () => {
    registerComponentHandler('a:', vi.fn());

    expect(() => registerComponentHandler('', vi.fn())).toThrow();
    expect(() => registerComponentHandler('a:', vi.fn())).toThrow(
      'already registered for "a:"'
    );
  });

  it('removes the route with the returned function, and only that route', () => {
    const unregister = registerComponentHandler('a:', vi.fn());
    unregister();

    expect(findComponentHandler('a:1')).toBeUndefined();

    // A later registration of the same prefix survives a stale unregister.
    const replacement = vi.fn();
    registerComponentHandler('a:', replacement);
    unregister();
    expect(findComponentHandler('a:1')?.handle).toBe(replacement);
  });
});

describe('component routing readiness', () => {
  it('starts not ready, so nothing is greyed out before features register', () => {
    expect(isComponentRoutingReady()).toBe(false);
  });

  it('follows what the composition root sets, and resets for the next test', () => {
    setComponentRoutingReady(true);
    expect(isComponentRoutingReady()).toBe(true);
    setComponentRoutingReady(false);
    expect(isComponentRoutingReady()).toBe(false);

    setComponentRoutingReady(true);
    clearComponentHandlers();
    expect(isComponentRoutingReady()).toBe(false);
  });
});
