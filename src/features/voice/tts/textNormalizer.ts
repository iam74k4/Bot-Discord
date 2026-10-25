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
 * first, and the reading for each word's lower-case form. Build it once per
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
 * Prepare a dictionary for `applyDictionary`. Words are matched longest first
 * and case-insensitively; among case variants of one word the first rule
 * wins. The global pattern is only ever used with `String.replace`, which
 * resets `lastIndex`, so one instance is safe to share.
 */
export function compileDictionary(
  dictionary: readonly DictionaryRule[]
): CompiledDictionary {
  const readings = new Map<string, string>();
  const words = [...dictionary]
    .filter((rule) => rule.word.length > 0)
    .sort((a, b) => b.word.length - a.word.length);
  for (const rule of words) {
    const key = rule.word.toLowerCase();
    if (!readings.has(key)) readings.set(key, rule.reading);
  }
  if (readings.size === 0) return { pattern: null, readings };

  const pattern = new RegExp(
    words.map((rule) => escapeRegExp(rule.word)).join('|'),
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

const EMOJI_PATTERN =
  /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u200D|\u20E3/gu;

/**
 * Long chat is cut with 以下略 ("the rest omitted") so listeners know there
 * was more; names and sticker titles are simply truncated.
 */
type Overflow = 'ellipsis' | 'truncate';

const OMITTED_SUFFIX = '、以下略';

function cutOff(text: string, maxLength: number, overflow: Overflow): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  const head = chars.slice(0, maxLength).join('');
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

/**
 * Normalize free text for speech. Returns '' when nothing is left to say.
 */
export function normalizeForSpeech(
  text: string,
  context: SpeechContext,
  maxLength: number = MAX_SPEECH_LENGTH,
  overflow: Overflow = 'ellipsis'
): string {
  let result = text
    // Say what was posted instead of reading it out.
    .replace(/```[\s\S]*?```/g, ' コード省略 ')
    .replace(/\|\|[\s\S]*?\|\|/g, ' ネタバレ ')
    .replace(/\[([^\]]+)\]\(<?https?:\/\/[^)\s]+>?\)/g, '$1')
    .replace(/<?https?:\/\/\S+/g, ' URL省略 ')
    // Discord markup that is unreadable as raw text.
    .replace(
      /<a?:(\w+):\d+>/g,
      (_m, name: string) => ` ${name.replace(/_/g, ' ')} `
    )
    .replace(
      /<@!?(\d+)>/g,
      (_m, id: string) => ` ${context.resolveUser(id) ?? 'だれか'} `
    )
    .replace(
      /<@&(\d+)>/g,
      (_m, id: string) => ` ${context.resolveRole(id) ?? 'ロール'} `
    )
    .replace(
      /<#(\d+)>/g,
      (_m, id: string) => ` ${context.resolveChannel(id) ?? 'チャンネル'} `
    )
    .replace(/<\/([\w\- ]+):\d+>/g, ' $1 ')
    .replace(/<t:-?\d+(?::[tTdDfFR])?>/g, ' 日時 ')
    .replace(/@(?:everyone|here)\b/g, ' みなさん ')
    // Markdown that would otherwise be read as symbols.
    .replace(/^\s*(?:>>>|>|-#|#{1,3})\s+/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(EMOJI_PATTERN, ' ')
    .replace(/\r?\n+/g, '、');

  // The server's dictionary wins over the built-in slang rule below.
  result = applyDictionary(result, context.dictionary);

  // Trailing w/ｗ is laughter (草www); a w inside an English word is not.
  result = result.replace(/(^|[^A-Za-z])[wｗ]+(?=$|[\s、。!！?？])/g, '$1わら');

  result = result
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s*、[\s、]*/g, '、')
    .replace(/^[\s、]+|[\s、]+$/g, '');

  return cutOff(result, maxLength, overflow);
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
