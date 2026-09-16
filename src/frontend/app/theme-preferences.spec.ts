import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyTheme, readStoredTheme, storeTheme, THEMES, THEME_STORAGE_KEY } from './theme-preferences';

describe('theme preferences', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers distinct palettes and restores a saved choice', () => {
    const values = new Map<string, string>([[THEME_STORAGE_KEY, 'violet']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });

    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(5);
    expect(readStoredTheme()).toBe('violet');
    storeTheme('teal');
    expect(values.get(THEME_STORAGE_KEY)).toBe('teal');
  });

  it('falls back to the default for unknown stored values and applies the selected theme', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'untrusted-theme' });
    const setAttribute = vi.fn();
    vi.stubGlobal('document', { documentElement: { setAttribute } });

    expect(readStoredTheme()).toBe('blue');
    applyTheme('rose');
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'rose');
  });
});
