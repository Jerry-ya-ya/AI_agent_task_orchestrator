import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';

export type AppPage = 'features' | 'taskboard' | 'history';

@Component({
  selector: 'app-navigation',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app-navigation.component.html',
})
export class AppNavigationComponent {
  @Input({ required: true }) expanded = false;
  @Input({ required: true }) activePage: AppPage = 'taskboard';
  @Input({ required: true }) historyCount = 0;

  @Output() expandedChange = new EventEmitter<boolean>();
  @Output() pageSelected = new EventEmitter<AppPage>();
}
