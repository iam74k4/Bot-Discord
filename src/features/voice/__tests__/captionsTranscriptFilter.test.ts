import { describe, expect, it } from 'vitest';
import {
  cleanTranscript,
  NO_SPEECH_THRESHOLD,
} from '../captions/transcriptFilter.js';

const text = (t: string) => ({ text: t, segments: [] });

describe('cleanTranscript', () => {
  it('keeps ordinary speech, trimmed and with whitespace collapsed', () => {
    expect(cleanTranscript(text('  今日は   いい天気ですね。 '))).toBe(
      '今日は いい天気ですね。'
    );
  });

  it.each([
    'ご視聴ありがとうございました',
    'ご視聴ありがとうございました。',
    ' ご視聴、ありがとうございました! ',
    'チャンネル登録よろしくお願いします',
    'Thank you for watching.',
    'you',
  ])('drops the phantom line %j Whisper invents for silence', (line) => {
    expect(cleanTranscript(text(line))).toBeNull();
  });

  it('keeps a phantom phrase when it is part of real speech', () => {
    expect(
      cleanTranscript(text('配信のご視聴ありがとうございました、また明日'))
    ).toBe('配信のご視聴ありがとうございました、また明日');
  });

  it.each(['(音楽)', '[拍手]', '♪♪♪', '（笑い） ［音楽］', '…', '。'])(
    'drops %j, which carries no speech',
    (annotation) => {
      expect(cleanTranscript(text(annotation))).toBeNull();
    }
  );

  it('strips annotations around real speech', () => {
    expect(cleanTranscript(text('(音楽) よろしくお願いします ♪'))).toBe(
      'よろしくお願いします'
    );
  });

  it('shortens a phrase stuck in a loop', () => {
    expect(
      cleanTranscript(text('はい、はい、はい、はい、はい、はい、はい、はい、'))
    ).toBe('はい、はい、はい、…');
  });

  it('drops a transcript the engine rates as not speech in every segment', () => {
    expect(
      cleanTranscript({
        text: 'こんにちは',
        segments: [
          { text: 'こんに', noSpeechProb: NO_SPEECH_THRESHOLD + 0.1 },
          { text: 'ちは', noSpeechProb: 0.99 },
        ],
      })
    ).toBeNull();
  });

  it('keeps it when any segment is likely speech, or the engine does not say', () => {
    expect(
      cleanTranscript({
        text: 'こんにちは',
        segments: [
          { text: 'こんに', noSpeechProb: 0.9 },
          { text: 'ちは', noSpeechProb: 0.1 },
        ],
      })
    ).toBe('こんにちは');
    expect(
      cleanTranscript({
        text: 'こんにちは',
        segments: [{ text: 'こんにちは' }],
      })
    ).toBe('こんにちは');
  });
});
