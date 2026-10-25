/**
 * Turn a Discord message into something worth hearing.
 *
 * Read literally, chat is unlistenable: a URL is spelled out character by
 * character, `<@123456789012345678>` becomes a string of digits, a code block
 * goes on for a minute. The rules here are the ones Japanese reading bots have
 * converged on - say what kind of thing was posted instead of reading it -
 * plus the server's own dictionary for names and slang.
 *
 * Pure on purpose: everything Discord-specific comes in through `SpeechContext`
 * so every rule is testable without a client.
 */

export interface DictionaryRule {
  word: string;
  reading: string;
}

/**
 * A server's dictionary ready to apply: one pattern for every word, longest
 * first, and the reading for each word's dictionaryKey. Build it once per
 * dictionary change (`compileDictionary`), not once per message.
 */
export interface CompiledDictionary {
  readonly pattern: RegExp | null;
  readonly readings: ReadonlyMap<string, string>;
}

export interface SpeechContext {
  resolveUser(id: string): string | undefined;
  resolveRole(id: string): string | undefined;
  resolveChannel(id: string): string | undefined;
  dictionary: readonly DictionaryRule[] | CompiledDictionary;
}

export interface MessageForSpeech {
  content: string;
  /** One entry per attachment: whether it is an image. */
  attachments: readonly { isImage: boolean }[];
  stickerNames: readonly string[];
}

/** Characters read from one message before cutting off with 以下略. */
export const MAX_SPEECH_LENGTH = 100;
/** Characters read from a display name announcing a new speaker. */
export const MAX_NAME_LENGTH = 20;

const SKIP_PREFIXES = [';', '；'];

/** Messages starting with `;` are the conventional "don't read this". */
export function isMarkedSilent(content: string): boolean {
  const trimmed = content.trimStart();
  return SKIP_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fold compatibility forms (NFKC) so text reads and matches the same however
 * it was typed: fullwidth ＡＢＣ and ｗ become ABC and w, halfwidth ｶﾀｶﾅ becomes
 * カタカナ, ① becomes 1. Pictographs are left alone - NFKC would turn some
 * emoji (™, ℹ, Ⓜ, ㊗) into letters to read out, and emoji are dropped instead.
 */
export function foldForSpeech(text: string): string {
  return text.replace(SPEECH_PATTERNS.compatibilityRun, (run) =>
    run.normalize('NFKC')
  );
}

/**
 * The one key a dictionary word is stored, looked up and matched by: folded
 * like chat text, then lower-cased. SQLite's NOCASE folds only ASCII, so
 * "ＡＬＩＣＥ" and "ａｌｉｃｅ" (or "CAFÉ" and "café") used to be two entries,
 * and a second member could add a variant of someone else's word.
 */
export function dictionaryKey(word: string): string {
  return foldForSpeech(word).toLowerCase();
}

/**
 * Prepare a dictionary for `applyDictionary`. Words are matched by
 * dictionaryKey, longest first; among variants with the same key the first
 * rule wins. The text it is applied to should already be folded with
 * foldForSpeech (normalizeForSpeech does that). The global pattern is only
 * ever used with `String.replace`, which resets `lastIndex`, so one instance
 * is safe to share.
 */
export function compileDictionary(
  dictionary: readonly DictionaryRule[]
): CompiledDictionary {
  const readings = new Map<string, string>();
  const rules = dictionary
    .map((rule) => ({ key: dictionaryKey(rule.word), reading: rule.reading }))
    .filter((rule) => rule.key.length > 0)
    .sort((a, b) => b.key.length - a.key.length);
  for (const rule of rules) {
    if (!readings.has(rule.key)) readings.set(rule.key, rule.reading);
  }
  if (readings.size === 0) return { pattern: null, readings };

  const pattern = new RegExp(
    [...readings.keys()].map(escapeRegExp).join('|'),
    'gi'
  );
  return { pattern, readings };
}

function isCompiled(
  dictionary: readonly DictionaryRule[] | CompiledDictionary
): dictionary is CompiledDictionary {
  return !Array.isArray(dictionary);
}

/**
 * Apply every dictionary rule in one pass, longest word first, so a reading
 * is never itself rewritten by a later rule.
 */
export function applyDictionary(
  text: string,
  dictionary: readonly DictionaryRule[] | CompiledDictionary
): string {
  if (text.length === 0) return text;
  if (!isCompiled(dictionary) && dictionary.length === 0) return text;

  const { pattern, readings } = isCompiled(dictionary)
    ? dictionary
    : compileDictionary(dictionary);
  if (!pattern) return text;

  return text.replace(
    pattern,
    (match) => readings.get(match.toLowerCase()) ?? match
  );
}

/**
 * Every pattern the normalizer runs, named so the ReDoS tests can drive each
 * one directly with long adversarial input.
 *
 * Chat is attacker-controlled and the dictionary can multiply a message's
 * length a hundredfold, so every pattern here must run in linear time: no
 * quantifier may be able to retry the same characters from many starting
 * points. The comments say what keeps each one linear; keep it that way when
 * adding a rule (src/features/voice/__tests__/ttsTextNormalizer.test.ts runs
 * them all against inputs where a quadratic pattern takes seconds).
 */
export const SPEECH_PATTERNS = {
  /** What foldForSpeech normalizes: any run without a pictograph. */
  compatibilityRun: /[^\p{Extended_Pictographic}]+/gu,
  /** A fenced block; every ``` either closes one or is the last, so one scan. */
  codeBlock: /```[\s\S]*?```/g,
  /** Same shape as code blocks. */
  spoiler: /\|\|[\s\S]*?\|\|/g,
  /**
   * A masked link keeps its label. Neither the label nor the URL may contain
   * `[`, so each attempt stops at the next one instead of rescanning the rest.
   */
  maskedLink: /\[([^[\]]+)\]\(<?https?:\/\/[^)\s[]+>?\)/g,
  /** Ends at the first whitespace and never fails once started. */
  url: /<?https?:\/\/\S+/g,
  /** `\w` cannot cross `<`, so attempts never overlap. */
  customEmoji: /<a?:(\w+):\d+>/g,
  userMention: /<@!?(\d+)>/g,
  roleMention: /<@&(\d+)>/g,
  channelMention: /<#(\d+)>/g,
  /** The name cannot contain `<`, so attempts never overlap. */
  slashCommand: /<\/([\w\- ]+):\d+>/g,
  timestamp: /<t:-?\d+(?::[tTdDfFR])?>/g,
  everyone: /@(?:everyone|here)\b/g,
  /**
   * Quote, heading and subtext markers at the start of a line. The leading
   * space must not include line breaks: `\s*` here would let every line start
   * rescan all the blank lines after it.
   */
  blockMarker:
    /^[^\S\r\n\u2028\u2029]*(?:>>>|>|-#|#{1,3})[^\S\r\n\u2028\u2029]+/gm,
  emphasis: /\*\*|__|~~|`/g,
  emoji:
    /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u200D|\u20E3/gu,
  lineBreak: /[\r\n\u2028\u2029]+/g,
  /**
   * Trailing w/ｗ is laughter (草www); a w inside an English word is not.
   * A match may only start right before a run, never inside one: with
   * `[^A-Za-z]` alone a fullwidth ｗ counted as a start, and a long run
   * followed by a letter was retried from every position (quadratic).
   */
  laughter: /(^|[^A-Za-zwｗ])[wｗ]+(?=$|[\s、。!！?？])/g,
  /**
   * Whitespace runs become one space. A lone space already is one, so it is
   * left alone: text with a space every other character would otherwise
   * cost a replacement per space. Never fails once started.
   */
  whitespace: /\s{2,}|[^\S ]/g,
  /**
   * Pauses: a 、 with the single spaces `whitespace` left around it, and
   * any 、 that follow. Optional one-character prefix, so no rescanning.
   */
  pauseRun: / ?、[ 、]*/g,
} as const;

/**
 * Text longer than this (in UTF-16 units) is cut before the rules run, again
 * before the dictionary, and once more after it (see capExpanded). Discord
 * caps a message at 4,000 characters, so real chat never reaches the first
 * cut; together they bound the work for any input, however far mentions and
 * the dictionary expand it.
 */
export const MAX_INPUT_LENGTH = 8_000;

/**
 * Long chat is cut with 以下略 ("the rest omitted") so listeners know there
 * was more; names and sticker titles are simply truncated.
 */
type Overflow = 'ellipsis' | 'truncate';

const OMITTED_SUFFIX = '、以下略';

/** The first `count` code points, never splitting a surrogate pair. */
function headCodePoints(text: string, count: number): string | null {
  let seen = 0;
  for (let i = 0; i < text.length; seen++) {
    if (seen === count) return text.slice(0, i);
    i += text.codePointAt(i)! > 0xffff ? 2 : 1;
  }
  return null;
}

function cutOff(text: string, maxLength: number, overflow: Overflow): string {
  // Walks only as far as the cut: the text can be hundreds of thousands of
  // characters after the dictionary, and only the head is ever spoken.
  const head = headCodePoints(text, maxLength);
  if (head === null) return text;
  return overflow === 'ellipsis' ? `${head}${OMITTED_SUFFIX}` : head;
}

/**
 * Two lines from the same speaker read as one, joined with 、. Null when
 * they do not fit in one message's length limit, so the second stays a line
 * of its own and is read in full instead of being cut off, and when the
 * first line was already cut short: reading on after 以下略 would make no
 * sense.
 */
export function joinSpeech(first: string, second: string): string | null {
  if (first.endsWith(OMITTED_SUFFIX)) return null;
  const joined = `${first}、${second}`;
  return Array.from(joined).length <= MAX_SPEECH_LENGTH ? joined : null;
}

/** Cut at MAX_INPUT_LENGTH UTF-16 units, on a code point boundary. */
function capInput(text: string): string {
  if (text.length <= MAX_INPUT_LENGTH) return text;
  const code = text.charCodeAt(MAX_INPUT_LENGTH - 1);
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return text.slice(0, MAX_INPUT_LENGTH - (isHighSurrogate ? 1 : 0));
}

/**
 * Cap the dictionary's output: each match can become a 100-unit reading, so
 * 8,000 units could grow to 800,000. A cut inside a w/ｗ run would show the
 * laughter rule a fake end of text (turning "wwwb" into laughter), so the
 * whole run is kept, plus the code point after it; one run is a single cheap
 * match whatever its length.
 */
function capExpanded(text: string): string {
  if (text.length <= MAX_INPUT_LENGTH) return text;
  let end = capInput(text).length;
  while (end < text.length && (text[end] === 'w' || text[end] === 'ｗ')) end++;
  if (end < text.length) end += text.codePointAt(end)! > 0xffff ? 2 : 1;
  return text.slice(0, end);
}

const SEPARATORS = new Set([' ', '、']);

/** Trim spaces and 、 from both ends with a plain scan (no `[...]+$`). */
function trimSeparators(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && SEPARATORS.has(text[start])) start++;
  while (end > start && SEPARATORS.has(text[end - 1])) end--;
  return text.slice(start, end);
}

/**
 * Normalize free text for speech. Returns '' when nothing is left to say.
 */
export function normalizeForSpeech(
  text: string,
  context: SpeechContext,
  maxLength: number = MAX_SPEECH_LENGTH,
  overflow: Overflow = 'ellipsis'
): string {
  const p = SPEECH_PATTERNS;
  // Resolved names are folded like the text, so the dictionary matches them.
  const name = (resolved: string | undefined, fallback: string) =>
    ` ${resolved === undefined ? fallback : foldForSpeech(resolved)} `;

  // Folded before the caps, since folding can lengthen text (﷽ is 18
  // characters in NFKC); the first cut only keeps that from being enormous.
  let result = capInput(foldForSpeech(capInput(text)))
    // Say what was posted instead of reading it out.
    .replace(p.codeBlock, ' コード省略 ')
    .replace(p.spoiler, ' ネタバレ ')
    .replace(p.maskedLink, '$1')
    .replace(p.url, ' URL省略 ')
    // Discord markup that is unreadable as raw text.
    .replace(
      p.customEmoji,
      (_m, name: string) => ` ${name.replace(/_/g, ' ')} `
    )
    .replace(p.userMention, (_m, id: string) =>
      name(context.resolveUser(id), 'だれか')
    )
    .replace(p.roleMention, (_m, id: string) =>
      name(context.resolveRole(id), 'ロール')
    )
    .replace(p.channelMention, (_m, id: string) =>
      name(context.resolveChannel(id), 'チャンネル')
    )
    .replace(p.slashCommand, ' $1 ')
    .replace(p.timestamp, ' 日時 ')
    .replace(p.everyone, ' みなさん ')
    // Markdown that would otherwise be read as symbols.
    .replace(p.blockMarker, '')
    .replace(p.emphasis, '')
    .replace(p.emoji, ' ')
    .replace(p.lineBreak, '、');

  // Mentions can grow into long names; cap again so the dictionary below,
  // which can multiply the length a hundredfold, starts from a bounded text,
  // and cap what it produces. The server's dictionary wins over the built-in
  // slang rule below.
  result = capExpanded(applyDictionary(capInput(result), context.dictionary));

  result = result
    .replace(p.laughter, '$1わら')
    .replace(p.whitespace, ' ')
    .replace(p.pauseRun, '、');

  return cutOff(trimSeparators(result), maxLength, overflow);
}

/**
 * Everything one message should say, or null when there is nothing to read.
 */
export function buildMessageSpeech(
  message: MessageForSpeech,
  context: SpeechContext
): string | null {
  const parts: string[] = [];

  const text = normalizeForSpeech(message.content, context);
  if (text) parts.push(text);

  if (message.attachments.length > 0) {
    parts.push(
      message.attachments.some((a) => a.isImage) ? '画像' : 'ファイル'
    );
  }
  for (const name of message.stickerNames) {
    const sticker = normalizeForSpeech(
      name,
      context,
      MAX_NAME_LENGTH,
      'truncate'
    );
    if (sticker) parts.push(`スタンプ ${sticker}`);
  }

  return parts.length > 0 ? parts.join('、') : null;
}

/** A display name as it should be announced, or '' if it has no readable text. */
export function speakableName(name: string, context: SpeechContext): string {
  return normalizeForSpeech(name, context, MAX_NAME_LENGTH, 'truncate');
}
