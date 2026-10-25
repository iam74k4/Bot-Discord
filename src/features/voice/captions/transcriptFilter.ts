import type { Transcript } from './whisperClient.js';

/**
 * What is worth posting from a Whisper transcript.
 *
 * Whisper was trained largely on subtitled video, and fed silence or noise it
 * produces the sign-off lines of that video with full confidence -
 * "ご視聴ありがとうございました" is the classic. Posting those as if someone had
 * said them would be worse than posting nothing, so whole-utterance matches
 * of known phantom lines are dropped, as are segments the engine itself rates
 * as probably not speech, and annotations such as (音楽) or ♪.
 */

/** Above this, the engine thinks a segment is not speech. */
export const NO_SPEECH_THRESHOLD = 0.6;

/** Phantom lines, compared after normalize(); only whole utterances. */
const PHANTOM_LINES = new Set(
  [
    'ご視聴ありがとうございました',
    'ご視聴ありがとうございます',
    'ご覧いただきありがとうございました',
    'ご覧いただきありがとうございます',
    'チャンネル登録よろしくお願いします',
    'チャンネル登録お願いします',
    'チャンネル登録をお願いします',
    'チャンネル登録よろしくね',
    '字幕視聴ありがとうございました',
    'thank you for watching',
    'thanks for watching',
    'please subscribe',
    'subtitles by the amara.org community',
    'you',
  ].map(normalize)
);

/** Lower case, without spaces or punctuation (Japanese and ASCII). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s、。，．,.!！?？…・「」『』"'~〜ー-]/g, '');
}

/** Bracketed sound annotations and music marks, e.g. (音楽) [拍手] ♪. */
const ANNOTATION = /[(（[［【][^)）\]］】]*[)）\]］】]|[♪♫🎵🎶]/gu;

/** A short phrase stuck in a loop: "あああああ…" or "はい、はい、はい、…". */
const LOOP = /(.{1,8}?)\1{5,}/gu;

export function cleanTranscript(transcript: Transcript): string | null {
  if (
    transcript.segments.length > 0 &&
    transcript.segments.every(
      (segment) => (segment.noSpeechProb ?? 0) > NO_SPEECH_THRESHOLD
    )
  ) {
    return null;
  }

  const text = transcript.text
    .replace(ANNOTATION, ' ')
    .replace(LOOP, '$1$1$1…')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || !normalize(text)) return null;
  if (PHANTOM_LINES.has(normalize(text))) return null;
  return text;
}
