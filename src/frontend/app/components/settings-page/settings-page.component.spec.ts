import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';

import { SettingsPageComponent } from './settings-page.component';

describe('SettingsPageComponent', () => {
  it('offers five palettes and emits the selected theme', () => {
    const component = new SettingsPageComponent();
    const selected = vi.spyOn(component.themeSelected, 'emit');

    expect(component.themes).toHaveLength(5);
    component.themeSelected.emit('amber');
    expect(selected).toHaveBeenCalledWith('amber');
  });

  it('keeps the original icon and offers selectable derived variants', () => {
    const component = new SettingsPageComponent();
    const selected = vi.spyOn(component.iconSelected, 'emit');

    expect(component.icons.map((icon) => icon.id)).toEqual(['original', 'violet', 'ember', 'frost']);
    expect(component.icons[0]?.source).toBe('favicon.svg');
    component.iconSelected.emit('frost');
    expect(selected).toHaveBeenCalledWith('frost');
  });
});
