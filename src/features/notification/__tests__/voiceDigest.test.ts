import { describe, expect, it } from 'vitest';
import {
  isVoiceDigestEmpty,
  summarizeVoiceActivity,
  type VoiceActivity,
} from '../application/voiceDigest.js';

function join(userId: string, channelId: string): VoiceActivity {
  return { userId, displayName: userId.toUpperCase(), channelId, kind: 'join' };
}

function leave(userId: string, channelId: string): VoiceActivity {
  return {
    userId,
    displayName: userId.toUpperCase(),
    channelId,
    kind: 'leave',
  };
}

describe('summarizeVoiceActivity', () => {
  it('keeps unrelated joins and leaves separate', () => {
    const digest = summarizeVoiceActivity([
      join('a', 'vc1'),
      leave('b', 'vc2'),
    ]);

    expect(digest.joined).toEqual([{ displayName: 'A', channelId: 'vc1' }]);
    expect(digest.left).toEqual([{ displayName: 'B', channelId: 'vc2' }]);
    expect(digest.moved).toEqual([]);
  });

  it('reports a leave followed by a join as one move', () => {
    const digest = summarizeVoiceActivity([
      leave('a', 'vc1'),
      join('a', 'vc2'),
    ]);

    expect(digest.moved).toEqual([
      { displayName: 'A', fromChannelId: 'vc1', toChannelId: 'vc2' },
    ]);
    expect(digest.joined).toEqual([]);
    expect(digest.left).toEqual([]);
  });

  it('drops a visit that started and ended inside the window', () => {
    const digest = summarizeVoiceActivity([
      join('a', 'vc1'),
      leave('a', 'vc1'),
    ]);

    expect(isVoiceDigestEmpty(digest)).toBe(true);
  });

  it('reports the original channel when a move is followed by a leave', () => {
    const digest = summarizeVoiceActivity([
      leave('a', 'vc1'),
      join('a', 'vc2'),
      leave('a', 'vc2'),
    ]);

    expect(digest.left).toEqual([{ displayName: 'A', channelId: 'vc1' }]);
    expect(digest.moved).toEqual([]);
  });

  it('collapses channel hopping to where the user ended up', () => {
    const digest = summarizeVoiceActivity([
      join('a', 'vc1'),
      leave('a', 'vc1'),
      join('a', 'vc2'),
    ]);

    expect(digest.joined).toEqual([{ displayName: 'A', channelId: 'vc2' }]);
    expect(digest.left).toEqual([]);
  });

  it('drops a reconnect to the same channel', () => {
    const digest = summarizeVoiceActivity([
      leave('a', 'vc1'),
      join('a', 'vc1'),
    ]);

    // Not "moved from #vc1 to #vc1".
    expect(isVoiceDigestEmpty(digest)).toBe(true);
  });

  it('drops a hop that returns to the starting channel', () => {
    const digest = summarizeVoiceActivity([
      leave('a', 'vc1'),
      join('a', 'vc2'),
      leave('a', 'vc2'),
      join('a', 'vc1'),
    ]);

    expect(isVoiceDigestEmpty(digest)).toBe(true);
  });

  it('still reports a reconnect that ends somewhere else', () => {
    const digest = summarizeVoiceActivity([
      leave('a', 'vc1'),
      join('a', 'vc1'),
      leave('a', 'vc1'),
      join('a', 'vc2'),
    ]);

    expect(digest.moved).toEqual([
      { displayName: 'A', fromChannelId: 'vc1', toChannelId: 'vc2' },
    ]);
  });

  it('uses the most recent display name', () => {
    const digest = summarizeVoiceActivity([
      { userId: 'a', displayName: 'Old', channelId: 'vc1', kind: 'join' },
      { userId: 'a', displayName: 'New', channelId: 'vc1', kind: 'leave' },
      { userId: 'a', displayName: 'New', channelId: 'vc2', kind: 'join' },
    ]);

    expect(digest.joined).toEqual([{ displayName: 'New', channelId: 'vc2' }]);
  });

  it('is empty for no events', () => {
    expect(isVoiceDigestEmpty(summarizeVoiceActivity([]))).toBe(true);
  });
});
