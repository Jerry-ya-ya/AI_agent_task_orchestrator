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

  it('keeps a feature color on a matching commit after it reaches main', () => {
    const component = new FeatureMapComponent();
    const lane = {
      name: 'feature/search', exists: true, is_current: false, is_primary: false,
      ahead: 0, behind: 0, fork_commit: commit('base', 'Base commit'),
      feature: { id: 7, project_id: 1, name: 'Search', branch_name: 'feature/search', base_branch: 'main', created_at: '', updated_at: '' },
      tasks: [{ ...task(1, 'DONE'), commit_summary: 'feat: index documents\n\nAdd the index.' }],
    } satisfies BranchLane;
    const map = {
      project: { id: 1, name: 'Project', repository_path: 'C:/repo', context: null, created_at: '', updated_at: '' },
      current_branch: 'main', primary_branch: 'main',
      primary_commits: [commit('feature', 'feat: index documents'), commit('base', 'Base commit')],
      branches: [lane],
    };

    expect(component.orderedPrimaryCommits(map).map((item) => item.sha)).toEqual(['base', 'feature']);
    expect(component.commitFeatureColors(map, 'feat: index documents')).toEqual([component.branchColor(0)]);
    expect(component.mainCommitFill(map, 'feat: index documents')).toBe(component.branchColor(0));
    expect(component.forkLabel(lane, map)).toBe('base · Base commit');
    expect(component.forkFeatureColors(map, 'base')).toEqual([component.branchColor(0)]);
    expect(component.commitFeatureColors({ ...map, branches: [{ ...lane, exists: false }] }, 'feat: index documents')).toEqual([component.branchColor(0)]);
    expect(component.networkWidth(map)).toBe(940);
    expect(component.forkOffset(map, lane)).toBe(0);
    expect(component.forkOffset(map, { ...lane, fork_commit: commit('feature', 'Feature commit') })).toBe(156);
    expect(component.connectorTop(0)).toBe(-79);
    expect(component.connectorHeight(0)).toBe(128);
  });

  it('places the youngest feature directly below main', () => {
    const component = new FeatureMapComponent();
    const older = lane(1, '2026-09-01T00:00:00.000Z');
    const younger = lane(2, '2026-09-06T00:00:00.000Z');
    const primary = { ...lane(3, '2026-08-01T00:00:00.000Z'), is_primary: true };
    const map = { project: { id: 1, name: 'Project', repository_path: 'C:/repo', context: null, created_at: '', updated_at: '' }, current_branch: 'main', primary_branch: 'main', primary_commits: [], branches: [older, primary, younger] };

    expect(component.featureLanes(map).map((item) => item.feature?.id)).toEqual([2, 1]);
  });
});

function commit(sha: string, summary: string) {
  return { sha, short_sha: sha, summary, committed_at: '2026-09-05T00:00:00.000Z' };
}

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

function lane(id: number, createdAt: string): BranchLane {
  return {
    name: `feature/${id}`, exists: true, is_current: false, is_primary: false,
    ahead: 1, behind: 0, fork_commit: null, tasks: [],
    feature: { id, project_id: 1, name: `Feature ${id}`, branch_name: `feature/${id}`, base_branch: 'main', created_at: createdAt, updated_at: createdAt },
  };
}
