import { describe, expect, it } from 'vitest';
import {
  applyDictionary,
  buildMessageSpeech,
  isMarkedSilent,
  MAX_NAME_LENGTH,
  MAX_SPEECH_LENGTH,
  normalizeForSpeech,
  speakableName,
  type DictionaryRule,
  type SpeechContext,
} from '../tts/textNormalizer.js';

/**
 * The normalizer is pure: everything Discord-specific arrives through the
 * context, so each rule is checked on its own with a tiny fake guild.
 */
const USERS: Record<string, string> = { '111': 'たろう' };
const ROLES: Record<string, string> = { '222': '管理者' };
const CHANNELS: Record<string, string> = { '333': '雑談' };

function context(dictionary: DictionaryRule[] = []): SpeechContext {
  return {
    resolveUser: (id) => USERS[id],
    resolveRole: (id) => ROLES[id],
    resolveChannel: (id) => CHANNELS[id],
    dictionary,
  };
}

const speak = (text: string, dictionary: DictionaryRule[] = []) =>
  normalizeForSpeech(text, context(dictionary));

describe('isMarkedSilent', () => {
  it.each([
    [';内緒', true],
    ['；全角', true],
    ['   ;leading spaces', true],
    ['\t\n;tabs and newlines', true],
    ['　；ideographic space', true],
    ['not; silent', false],
    ['普通の発言', false],
    ['', false],
    [':colon', false],
  ])('%j -> %s', (content, expected) => {
    expect(isMarkedSilent(content)).toBe(expected);
  });
});

describe('applyDictionary', () => {
  it('returns the text unchanged with an empty dictionary or text', () => {
    expect(applyDictionary('abc', [])).toBe('abc');
    expect(applyDictionary('', [{ word: 'a', reading: 'えー' }])).toBe('');
  });

  it('ignores rules with an empty word', () => {
    expect(applyDictionary('abc', [{ word: '', reading: 'x' }])).toBe('abc');
  });

  it('matches case-insensitively and replaces every occurrence', () => {
    expect(
      applyDictionary('ABC abc Abc', [{ word: 'abc', reading: 'えーびーしー' }])
    ).toBe('えーびーしー えーびーしー えーびーしー');
  });

  it('prefers the longest word regardless of rule order', () => {
    const rules = [
      { word: '東京', reading: 'とうきょう' },
      { word: '東京タワー', reading: 'とうきょうたわー' },
    ];
    expect(applyDictionary('東京タワーと東京', rules)).toBe(
      'とうきょうたわーととうきょう'
    );
    expect(applyDictionary('東京タワーと東京', [...rules].reverse())).toBe(
      'とうきょうたわーととうきょう'
    );
  });

  it('never rewrites a reading with a later rule (single pass)', () => {
    // a -> b, then b -> c must not chain into "cc".
    expect(
      applyDictionary('ab', [
        { word: 'a', reading: 'b' },
        { word: 'b', reading: 'c' },
      ])
    ).toBe('bc');
  });

  it('treats regex metacharacters in words literally', () => {
    expect(applyDictionary('a.b a+b', [{ word: '.', reading: 'ドット' }])).toBe(
      'aドットb a+b'
    );
    expect(applyDictionary('C++ と C', [{ word: 'C++', reading: 'しーぷら' }])).toBe(
      'しーぷら と C'
    );
  });

  it('uses the first rule among case-insensitive duplicates of equal length', () => {
    expect(
      applyDictionary('Bot', [
        { word: 'BOT', reading: 'ぼっと' },
        { word: 'bot', reading: 'ぼと' },
      ])
    ).toBe('ぼっと');
  });
});

describe('normalizeForSpeech', () => {
  describe('links and code', () => {
    it('replaces bare URLs with URL省略', () => {
      expect(speak('見て https://example.com/a?b=c これ')).toBe(
        '見て URL省略 これ'
      );
      expect(speak('http://example.com')).toBe('URL省略');
      expect(speak('<https://example.com/embedless>')).toBe('URL省略');
    });

    it('keeps the visible text of masked links', () => {
      expect(speak('[公式サイト](https://example.com) を見て')).toBe(
        '公式サイト を見て'
      );
      expect(speak('[docs](<https://example.com/x>)')).toBe('docs');
    });

    it('replaces fenced code blocks with コード省略', () => {
      expect(speak('before ```ts\nconst a = 1;\nhttps://x.y\n``` after')).toBe(
        'before コード省略 after'
      );
    });

    it('strips inline code backticks and markdown emphasis', () => {
      expect(speak('**bold** __under__ ~~strike~~ `code`')).toBe(
        'bold under strike code'
      );
    });

    it('replaces spoilers with ネタバレ', () => {
      expect(speak('犯人は ||あの人|| だった')).toBe('犯人は ネタバレ だった');
      expect(speak('||https://example.com||')).toBe('ネタバレ');
    });

    it('drops quote and heading markers', () => {
      expect(speak('> 引用')).toBe('引用');
      expect(speak('>>> 長い引用')).toBe('長い引用');
      expect(speak('# 見出し')).toBe('見出し');
      expect(speak('-# 小さい字')).toBe('小さい字');
    });
  });

  describe('Discord markup', () => {
    it('reads custom emoji by name with underscores as spaces', () => {
      expect(speak('hi <:pepe_happy:123456789> there')).toBe(
        'hi pepe happy there'
      );
      expect(speak('<a:dance:987654321>')).toBe('dance');
    });

    it('resolves user mentions, including the legacy nickname form', () => {
      expect(speak('<@111> と <@!111>')).toBe('たろう と たろう');
    });

    it('falls back to だれか for unknown users', () => {
      expect(speak('<@999>')).toBe('だれか');
    });

    it('resolves role mentions, falling back to ロール', () => {
      expect(speak('<@&222> <@&999>')).toBe('管理者 ロール');
    });

    it('resolves channel mentions, falling back to チャンネル', () => {
      expect(speak('<#333> <#999>')).toBe('雑談 チャンネル');
    });

    it('reads @everyone and @here as みなさん', () => {
      expect(speak('@everyone 集合 @here')).toBe('みなさん 集合 みなさん');
    });

    it('reads slash command mentions and timestamps', () => {
      expect(speak('</tts start:123>')).toBe('tts start');
      expect(speak('<t:1700000000:R> に集合')).toBe('日時 に集合');
      expect(speak('<t:1700000000>')).toBe('日時');
    });
  });

  describe('unicode emoji', () => {
    it.each([
      ['plain', 'a👍b', 'a b'],
      ['ZWJ family', '👨‍👩‍👧 家族', '家族'],
      ['ZWJ with skin tone', '👩🏽‍💻 開発', '開発'],
      ['flag', '🇯🇵 日本', '日本'],
      ['rainbow flag (VS16 + ZWJ)', '🏳️‍🌈 虹', '虹'],
      ['skin tone', '👍🏽 いいね', 'いいね'],
      ['only emoji', '😀😀😀', ''],
    ])('removes %s', (_label, input, expected) => {
      expect(speak(input)).toBe(expected);
    });

    it('removes the keycap marks but keeps the base character', () => {
      // Documenting current behaviour: 1️⃣ is read as its digit.
      expect(speak('1️⃣ ばん')).toBe('1 ばん');
      expect(speak('#️⃣')).toBe('#');
      expect(speak('1️⃣')).not.toContain('⃣');
      expect(speak('1️⃣')).not.toContain('️');
    });
  });

  describe('whitespace and newlines', () => {
    it('turns newlines into 、 and collapses runs', () => {
      expect(speak('行1\n行2\r\n\n行3')).toBe('行1、行2、行3');
    });

    it('collapses spaces (including ideographic) and trims the ends', () => {
      expect(speak('  あ \t　 い  ')).toBe('あ い');
    });

    it('trims leading and trailing 、', () => {
      expect(speak('\nあ\n')).toBe('あ');
    });

    it('returns an empty string when nothing readable remains', () => {
      expect(speak('')).toBe('');
      expect(speak('   \n  ')).toBe('');
      expect(speak('👍')).toBe('');
      expect(speak('**``**')).toBe('');
    });
  });

  describe('laughter', () => {
    it.each([
      ['草www', '草わら'],
      ['ｗｗｗ', 'わら'],
      ['w', 'わら'],
      ['そうだねw', 'そうだねわら'],
      ['まじかww!', 'まじかわら!'],
      ['ww\nうける', 'わら、うける'],
      ['ww ww', 'わら わら'],
    ])('%j -> %j', (input, expected) => {
      expect(speak(input)).toBe(expected);
    });

    it.each(['new', 'wow', 'awww', 'www.example', 'show'])(
      'leaves English words like %j alone',
      (input) => {
        expect(speak(input)).toBe(input);
      }
    );

    it('lets the dictionary win over the w rule', () => {
      expect(speak('草w', [{ word: 'w', reading: 'ダブリュー' }])).toBe(
        '草ダブリュー'
      );
      expect(speak('草ｗ', [{ word: 'ｗ', reading: 'だぶ' }])).toBe('草だぶ');
    });
  });

  describe('dictionary', () => {
    it('applies the dictionary case-insensitively to normalized text', () => {
      expect(
        speak('VOICEVOX と voicevox', [
          { word: 'voicevox', reading: 'ボイスボックス' },
        ])
      ).toBe('ボイスボックス と ボイスボックス');
    });

    it('applies the dictionary to resolved mention names', () => {
      expect(speak('<@111>', [{ word: 'たろう', reading: 'タロー' }])).toBe(
        'タロー'
      );
    });
  });

  describe('length limits', () => {
    it(`keeps exactly ${MAX_SPEECH_LENGTH} characters`, () => {
      const text = 'あ'.repeat(MAX_SPEECH_LENGTH);
      expect(speak(text)).toBe(text);
    });

    it(`cuts longer text at ${MAX_SPEECH_LENGTH} with 、以下略`, () => {
      expect(speak('あ'.repeat(MAX_SPEECH_LENGTH + 1))).toBe(
        `${'あ'.repeat(MAX_SPEECH_LENGTH)}、以下略`
      );
    });

    it('counts code points, not UTF-16 units', () => {
      // 𠮷 is a surrogate pair; 100 of them must not be cut.
      const text = '𠮷'.repeat(MAX_SPEECH_LENGTH);
      expect(speak(text)).toBe(text);
      expect(speak(`${text}𠮷`)).toBe(`${text}、以下略`);
    });

    it('honours a custom limit and truncate mode', () => {
      expect(normalizeForSpeech('abcdef', context(), 3, 'truncate')).toBe(
        'abc'
      );
      expect(normalizeForSpeech('abcdef', context(), 3)).toBe('abc、以下略');
    });
  });
});

describe('speakableName', () => {
  it(`truncates names to ${MAX_NAME_LENGTH} characters without 以下略`, () => {
    expect(speakableName('あ'.repeat(MAX_NAME_LENGTH + 5), context())).toBe(
      'あ'.repeat(MAX_NAME_LENGTH)
    );
  });

  it('normalizes names like any other text', () => {
    expect(speakableName('🌸さくら🌸', context())).toBe('さくら');
    expect(
      speakableName('Taro', context([{ word: 'taro', reading: 'たろ' }]))
    ).toBe('たろ');
  });

  it("returns '' for a name with nothing readable", () => {
    expect(speakableName('✨✨', context())).toBe('');
  });
});

describe('buildMessageSpeech', () => {
  const message = (
    content: string,
    attachments: { isImage: boolean }[] = [],
    stickerNames: string[] = []
  ) => ({ content, attachments, stickerNames });

  it('returns null when there is nothing to say', () => {
    expect(buildMessageSpeech(message(''), context())).toBeNull();
    expect(buildMessageSpeech(message('👍'), context())).toBeNull();
    expect(buildMessageSpeech(message('', [], ['🎉']), context())).toBeNull();
  });

  it('returns the normalized text alone', () => {
    expect(buildMessageSpeech(message('こんにちは'), context())).toBe(
      'こんにちは'
    );
  });

  it('says 画像 when any attachment is an image', () => {
    expect(
      buildMessageSpeech(
        message('見て', [{ isImage: false }, { isImage: true }]),
        context()
      )
    ).toBe('見て、画像');
  });

  it('says ファイル when no attachment is an image', () => {
    expect(
      buildMessageSpeech(message('', [{ isImage: false }]), context())
    ).toBe('ファイル');
  });

  it('appends each sticker by name, truncated and skipping empty ones', () => {
    expect(
      buildMessageSpeech(
        message('hi', [], ['ねこ', '👍', 'い'.repeat(MAX_NAME_LENGTH + 3)]),
        context()
      )
    ).toBe(`hi、スタンプ ねこ、スタンプ ${'い'.repeat(MAX_NAME_LENGTH)}`);
  });

  it('orders text, attachments, then stickers', () => {
    expect(
      buildMessageSpeech(
        message('やあ', [{ isImage: true }], ['うさぎ']),
        context()
      )
    ).toBe('やあ、画像、スタンプ うさぎ');
  });
});
