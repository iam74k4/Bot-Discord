import { describe, expect, it } from 'vitest';
import {
  NAME_CACHE_MAX_BYTES,
  NAME_CACHE_MAX_ENTRIES,
  NameAudioCache,
} from '../tts/nameAudioCache.js';

const pcm = (bytes: number, fill = 1) => Buffer.alloc(bytes, fill);

describe('NameAudioCache', () => {
  it('returns what was stored for the same name, voice and speed', () => {
    const cache = new NameAudioCache();
    const audio = pcm(8);

    cache.set('たろう', 3, 1, audio);

    expect(cache.get('たろう', 3, 1)).toBe(audio);
    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(8);
  });

  it.each([
    ['another voice', 'たろう', 2, 1],
    ['another speed', 'たろう', 3, 1.5],
    ['another name', 'はなこ', 3, 1],
  ])('misses for %s', (_label, name, speakerId, speed) => {
    const cache = new NameAudioCache();
    cache.set('たろう', 3, 1, pcm(8));

    expect(cache.get(name, speakerId, speed)).toBeUndefined();
  });

  it('evicts the least recently used entry beyond the entry limit', () => {
    const cache = new NameAudioCache(2, 1_000);
    cache.set('a', 3, 1, pcm(1));
    cache.set('b', 3, 1, pcm(1));
    // Reading a makes b the oldest.
    cache.get('a', 3, 1);

    cache.set('c', 3, 1, pcm(1));

    expect(cache.get('b', 3, 1)).toBeUndefined();
    expect(cache.get('a', 3, 1)).toBeDefined();
    expect(cache.get('c', 3, 1)).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it('evicts the oldest entries beyond the byte limit', () => {
    const cache = new NameAudioCache(10, 10);
    cache.set('a', 3, 1, pcm(4));
    cache.set('b', 3, 1, pcm(4));

    cache.set('c', 3, 1, pcm(4));

    expect(cache.get('a', 3, 1)).toBeUndefined();
    expect(cache.byteLength).toBe(8);
  });

  it('replaces an entry without counting it twice', () => {
    const cache = new NameAudioCache(10, 10);
    cache.set('a', 3, 1, pcm(6));
    cache.set('a', 3, 1, pcm(4, 2));

    expect(cache.byteLength).toBe(4);
    expect(cache.get('a', 3, 1)?.[0]).toBe(2);
  });

  it('never stores empty audio or audio larger than the whole cache', () => {
    const cache = new NameAudioCache(10, 10);
    cache.set('empty', 3, 1, pcm(0));
    cache.set('huge', 3, 1, pcm(11));

    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
  });

  it('clears everything', () => {
    const cache = new NameAudioCache();
    cache.set('a', 3, 1, pcm(4));

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
    expect(cache.get('a', 3, 1)).toBeUndefined();
  });

  it('defaults to a few dozen names and a few megabytes', () => {
    expect(NAME_CACHE_MAX_ENTRIES).toBe(32);
    expect(NAME_CACHE_MAX_BYTES).toBe(6 * 1024 * 1024);
  });
});
