import '@angular/compiler';
import { describe, expect, it } from 'vitest';

import type { BranchLane } from '../../models';
import { FeatureMapComponent } from './feature-map.component';

describe('FeatureMapComponent', () => {
  it('highlights the checkpoint immediately before the first unhandled task', () => {
    const component = new FeatureMapComponent();
    const lane = {
      name: 'feature/search',
      exists: true,
      is_current: false,
      feature: null,
      tasks: [
        task(1, 'DONE'),
        task(2, 'IN_REVIEW'),
        task(3, 'TODO'),
        task(4, 'TODO'),
      ],
    } satisfies BranchLane;

    expect(component.isCheckpoint(lane, lane.tasks[1]!)).toBe(true);
    expect(component.isCheckpoint(lane, lane.tasks[0]!)).toBe(false);
    expect(component.isCheckpoint(lane, lane.tasks[2]!)).toBe(false);
    expect(component.highlightStart(lane)).toBe(false);
    expect(component.highlightStart({ ...lane, tasks: [task(5, 'TODO')] })).toBe(true);
  });
});

function task(id: number, status: BranchLane['tasks'][number]['status']): BranchLane['tasks'][number] {
  return {
    id,
    title: `Task ${id}`,
    status,
    commit_summary: null,
    created_at: '2026-09-05T00:00:00.000Z',
    updated_at: '2026-09-05T00:00:00.000Z',
  };
}
