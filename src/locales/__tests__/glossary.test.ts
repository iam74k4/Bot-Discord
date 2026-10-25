import { describe, expect, it } from 'vitest';
import { ja } from '../ja.js';

/**
 * The glossary at the top of ja.ts, enforced for the terms that kept coming
 * back. Each entry is a pattern the Japanese copy must not contain and the
 * term to use instead. ボイスチャンネル is deliberately not banned: it is
 * Discord's own term and fine in command descriptions.
 */
const BANNED: Array<[RegExp, string]> = [
  [/剥奪/, '外す / 付与・解除'],
  [/バッファ/, '保持'],
  [/ウィンドウ/, '保持時間'],
  [/セレクト/, 'メニュー'],
  [/Botオーナー/, 'Bot運営者'],
  [/録音対象外/, '自動参加の対象外'],
  [/Bot [ぁ-んァ-ヶ一-龠]/, 'Botが / Botの (no space)'],
  [/\.\.\./, '…'],
];

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key)
  );
}

describe('Japanese glossary', () => {
  it.each(BANNED)('never uses %s (use %s)', (pattern) => {
    const offenders = leaves(ja)
      .filter(([, text]) => pattern.test(text))
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });
});
