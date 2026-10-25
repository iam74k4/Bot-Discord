import { afterEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import {
  clearSettingsSummaries,
  collectSettingsSummaries,
  formatSettingValue,
  registerSettingsSummary,
} from '../registry.js';
import { clearCommandIds, setCommandIds } from '../../utils/commandMentions.js';
import { t } from '../../../locales/index.js';

afterEach(() => {
  clearSettingsSummaries();
  clearCommandIds();
  vi.clearAllMocks();
});

const context = { guildId: 'g1', locale: 'ja' as const };

describe('settings summary registry', () => {
  it('collects every provider, ordered by order and then id', async () => {
    registerSettingsSummary('voice', () => [{ name: 'VC', value: 'on' }], {
      order: 20,
    });
    registerSettingsSummary('notification', async () => [
      { name: 'VC通知', value: '<#1>' },
      { name: '参加通知', value: '未設定' },
    ]);
    registerSettingsSummary('alpha', () => [{ name: 'A', value: 'a' }], {
      order: 20,
    });

    const fields = await collectSettingsSummaries(context);

    expect(fields.map((field) => field.name)).toEqual([
      'A',
      'VC',
      'VC通知',
      '参加通知',
    ]);
  });

  it('hands each provider the guild and locale it was asked for', async () => {
    const provider = vi.fn().mockReturnValue([]);
    registerSettingsSummary('voice', provider);

    await collectSettingsSummaries(context);

    expect(provider).toHaveBeenCalledWith(context);
  });

  it('skips and logs a provider that throws, keeping the others', async () => {
    registerSettingsSummary('broken', () => {
      throw new Error('db down');
    });
    registerSettingsSummary('ok', () => [{ name: 'OK', value: 'yes' }]);

    const fields = await collectSettingsSummaries(context);

    expect(fields).toEqual([{ name: 'OK', value: 'yes' }]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Settings summary "broken" failed: db down'
    );
  });

  it('replaces a provider registered again under the same id', async () => {
    registerSettingsSummary('voice', () => [{ name: 'old', value: '1' }]);
    registerSettingsSummary('voice', () => [{ name: 'new', value: '2' }]);

    expect(await collectSettingsSummaries(context)).toEqual([
      { name: 'new', value: '2' },
    ]);
  });

  it('removes a provider with the returned function', async () => {
    const unregister = registerSettingsSummary('voice', () => [
      { name: 'VC', value: 'on' },
    ]);
    unregister();

    expect(await collectSettingsSummaries(context)).toEqual([]);
  });
});

describe('formatSettingValue', () => {
  it('shows a set value unchanged', () => {
    expect(formatSettingValue('<#123>', 'ja', 'notification voice set')).toBe(
      '<#123>'
    );
  });

  it('turns an unset value into a setup hint with the command', () => {
    expect(formatSettingValue(null, 'ja', 'notification voice set')).toBe(
      t('common.notSetWithHint', 'ja', {
        command: '`/notification voice set`',
      })
    );

    setCommandIds([{ name: 'notification', id: '42' }]);
    expect(formatSettingValue('', 'en', 'notification voice set')).toContain(
      '</notification voice set:42>'
    );
  });

  it('says only "not set" when there is no command to suggest', () => {
    expect(formatSettingValue(undefined, 'ja')).toBe('未設定');
    expect(formatSettingValue(null, 'en')).toBe('Not set');
  });
});
