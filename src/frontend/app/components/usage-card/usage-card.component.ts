import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import type { AgentUsage, AgentUsageWindow } from '../../models';

@Component({ selector: 'usage-card', standalone: true, imports: [CommonModule], templateUrl: './usage-card.component.html' })
export class UsageCardComponent {
  @Input() usage: AgentUsage | null = null;

  windowLabel(window: AgentUsageWindow): string {
    if (window.windowDurationMins === null) return 'Usage window';
    if (window.windowDurationMins >= 1_440 && window.windowDurationMins % 1_440 === 0) return `${window.windowDurationMins / 1_440}-day window`;
    if (window.windowDurationMins >= 60 && window.windowDurationMins % 60 === 0) return `${window.windowDurationMins / 60}-hour window`;
    return `${window.windowDurationMins}-minute window`;
  }

  resetDate(window: AgentUsageWindow): Date | null {
    return window.resetsAt === null ? null : new Date(window.resetsAt * 1_000);
  }
}
