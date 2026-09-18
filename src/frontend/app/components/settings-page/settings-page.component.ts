import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';

import { THEMES, type ThemeId } from '../../theme-preferences';
import { ICONS, type IconId } from '../../icon-preferences';

@Component({
  selector: 'settings-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.css',
})
export class SettingsPageComponent {
  readonly themes = THEMES;
  readonly icons = ICONS;

  @Input({ required: true }) selectedTheme: ThemeId = 'blue';
  @Output() themeSelected = new EventEmitter<ThemeId>();
  @Input({ required: true }) selectedIcon: IconId = 'original';
  @Output() iconSelected = new EventEmitter<IconId>();
}
