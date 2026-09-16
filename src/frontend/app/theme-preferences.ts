export const THEME_STORAGE_KEY = 'agentboard.theme';

export const THEMES = [
  { id: 'blue', name: 'Ocean blue', description: 'The original Agentboard palette.', swatch: '#3779e8' },
  { id: 'teal', name: 'Forest teal', description: 'A calm green-blue workspace.', swatch: '#138c83' },
  { id: 'violet', name: 'Amethyst', description: 'A rich violet accent.', swatch: '#7956c8' },
  { id: 'amber', name: 'Warm amber', description: 'A warmer, softer contrast.', swatch: '#b86818' },
  { id: 'rose', name: 'Rose', description: 'A bright rose accent.', swatch: '#be4869' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export const DEFAULT_THEME: ThemeId = 'blue';

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function readStoredTheme(): ThemeId {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: ThemeId): void {
  globalThis.document?.documentElement?.setAttribute('data-theme', theme);
}

export function storeTheme(theme: ThemeId): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme selection still works for this window when storage is unavailable.
  }
}
