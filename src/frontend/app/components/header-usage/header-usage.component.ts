import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import type { AgentUsage, AgentUsageWindow } from '../../models';

@Component({
  selector: 'header-usage',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './header-usage.component.html',
})
export class HeaderUsageComponent {
  @Input() usage: AgentUsage | null = null;

  usageWindows(): AgentUsageWindow[] {
    if (!this.usage?.available) return [];
    return [this.usage.primary, this.usage.secondary].filter(
      (window): window is AgentUsageWindow => window !== null,
    );
  }

  windowLabel(window: AgentUsageWindow): string {
    const minutes = window.windowDurationMins;
    if (minutes === null) return 'Usage';
    if (minutes >= 1_440 && minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }

  isFiveHourWindow(window: AgentUsageWindow): boolean {
    return window.windowDurationMins === 300;
  }

  resetDate(window: AgentUsageWindow): Date | null {
    return window.resetsAt === null ? null : new Date(window.resetsAt * 1_000);
  }

  statusTitle(): string {
    if (this.usage === null) return 'Checking Codex usage';
    if (!this.usage.available) return this.usage.message || 'Codex usage unavailable';
    const windows = this.usageWindows()
      .map((window) => `${this.windowLabel(window)}: ${window.remainingPercent}% remaining`)
      .join(', ');
    return windows || 'Codex usage is available';
  }
}
