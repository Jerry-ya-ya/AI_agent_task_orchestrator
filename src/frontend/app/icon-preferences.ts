export const ICON_STORAGE_KEY = 'agentboard.icon';

export const ICONS = [
  { id: 'original', name: 'Original', description: 'The original teal C and crossbar.', source: 'favicon.svg' },
  { id: 'violet', name: 'Violet', description: 'A soft purple night palette.', source: 'icon-violet.svg' },
  { id: 'ember', name: 'Ember', description: 'Warm coral on deep brown.', source: 'icon-ember.svg' },
  { id: 'frost', name: 'Frost', description: 'Dark blue on a pale surface.', source: 'icon-frost.svg' },
] as const;

export type IconId = (typeof ICONS)[number]['id'];
export const DEFAULT_ICON: IconId = 'original';

export function isIconId(value: unknown): value is IconId {
  return ICONS.some((icon) => icon.id === value);
}

export function iconSource(icon: IconId): string {
  return ICONS.find((candidate) => candidate.id === icon)?.source ?? 'favicon.svg';
}

export function readStoredIcon(): IconId {
  try {
    const value = globalThis.localStorage?.getItem(ICON_STORAGE_KEY);
    return isIconId(value) ? value : DEFAULT_ICON;
  } catch {
    return DEFAULT_ICON;
  }
}

export function storeIcon(icon: IconId): void {
  try {
    globalThis.localStorage?.setItem(ICON_STORAGE_KEY, icon);
  } catch {
    // The choice still applies in this window if storage is unavailable.
  }
}

export function applyIcon(icon: IconId): void {
  globalThis.document?.querySelector?.('link[rel="icon"]')?.setAttribute('href', iconSource(icon));
}
