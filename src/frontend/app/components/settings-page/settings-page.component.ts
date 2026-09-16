import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';

import { THEMES, type ThemeId } from '../../theme-preferences';

@Component({
  selector: 'settings-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.css',
})
export class SettingsPageComponent {
  readonly themes = THEMES;

  @Input({ required: true }) selectedTheme: ThemeId = 'blue';
  @Output() themeSelected = new EventEmitter<ThemeId>();
}
