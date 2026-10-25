import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `/admin settings view` shows about voice: the auto-join switch and
 * the channels the bot stays out of, in the reader's language.
 */
const repository = vi.hoisted(() => ({
  isAutoJoinEnabled: vi.fn(() => true),
  listExclusions: vi.fn((): string[] => []),
}));

vi.mock('../repositories/voiceSettingsRepository.js', () => ({
  voiceSettingsRepository: repository,
}));

const { voiceSettingsSummary } =
  await import('../application/settingsSummary.js');
const { t } = await import('../../../locales/index.js');

describe('voiceSettingsSummary', () => {
  beforeEach(() => {
    repository.isAutoJoinEnabled.mockReturnValue(true);
    repository.listExclusions.mockReturnValue([]);
  });

  it('shows auto-join on and no exclusions for a server that changed nothing', () => {
    expect(voiceSettingsSummary({ guildId: 'g1', locale: 'ja' })).toEqual([
      {
        name: t('record.autojoin.title', 'ja'),
        value: t('record.autojoin.statusEnabled', 'ja'),
        inline: true,
      },
      {
        name: t('record.autojoin.exclusions', 'ja'),
        value: t('record.autojoin.exclusionsNone', 'ja'),
        inline: true,
      },
    ]);
    expect(repository.isAutoJoinEnabled).toHaveBeenCalledWith('g1');
    expect(repository.listExclusions).toHaveBeenCalledWith('g1');
  });

  it('shows auto-join off and lists the excluded channels', () => {
    repository.isAutoJoinEnabled.mockReturnValue(false);
    repository.listExclusions.mockReturnValue(['vc-1', 'vc-2']);

    const [autoJoin, exclusions] = voiceSettingsSummary({
      guildId: 'g1',
      locale: 'en',
    });

    expect(autoJoin?.value).toBe(t('record.autojoin.statusDisabled', 'en'));
    expect(exclusions?.value).toBe('<#vc-1> <#vc-2>');
  });

  it('cuts a long exclusion list to fit an embed field', () => {
    repository.listExclusions.mockReturnValue(
      Array.from({ length: 80 }, (_, i) => `${100000000000000000n + BigInt(i)}`)
    );

    const [, exclusions] = voiceSettingsSummary({
      guildId: 'g1',
      locale: 'en',
    });

    expect(exclusions!.value.length).toBeLessThanOrEqual(1024);
    expect(exclusions!.value).toMatch(/ \+\d+ more$/);
  });
});
