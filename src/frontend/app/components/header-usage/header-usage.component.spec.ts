import '@angular/compiler';

import { describe, expect, it } from 'vitest';
import type { AgentUsage } from '../../models';
import { HeaderUsageComponent } from './header-usage.component';

describe('HeaderUsageComponent', () => {
  it('shows compact labels and remaining percentages for available usage windows', () => {
    const component = new HeaderUsageComponent();
    component.usage = exampleUsage();

    expect(component.usageWindows().map((window) => component.windowLabel(window))).toEqual(['5h', '7d']);
    expect(component.statusTitle()).toBe('5h: 74% remaining, 7d: 42% remaining');
  });

  it('uses the backend message when usage is unavailable', () => {
    const component = new HeaderUsageComponent();
    component.usage = { ...exampleUsage(), available: false, message: 'Codex is offline.' };

    expect(component.usageWindows()).toEqual([]);
    expect(component.statusTitle()).toBe('Codex is offline.');
  });
});

function exampleUsage(): AgentUsage {
  return {
    available: true,
    planType: 'plus',
    primary: { remainingPercent: 74, usedPercent: 26, windowDurationMins: 300, resetsAt: null },
    secondary: { remainingPercent: 42, usedPercent: 58, windowDurationMins: 10_080, resetsAt: null },
    resetCredits: 0,
    checkedAt: '2026-09-05T00:00:00.000Z',
    message: 'Codex usage is available.',
  };
}
