import '@angular/compiler';
import { describe, expect, it } from 'vitest';

import type { BranchLane, ProjectBranchMap } from '../../models';
import { CytoscapeBranchGraphComponent } from './cytoscape-branch-graph.component';

describe('CytoscapeBranchGraphComponent', () => {
  it('uses normal zoom speed by default and accepts supported zoom multipliers', () => {
    const component = new CytoscapeBranchGraphComponent();

    expect(component.zoomSensitivity).toBe(1);
    component.setZoomSensitivity('3');
    expect(component.zoomSensitivity).toBe(3);
    component.setZoomSensitivity('4');
    expect(component.zoomSensitivity).toBe(3);
  });

  it('builds Cytoscape nodes and edges for main, fork, and task history', () => {
    const component = new CytoscapeBranchGraphComponent();
    const feature = lane();
    component.map = map(feature);
    component.lanes = [feature];

    const model = component.graphModel();
    const featureCommit = model.elements.find((element) => element.data.id === 'primary:feature');
    const forkEdge = model.elements.find((element) => element.data.id === 'fork-edge:0');
    const checkpoint = model.elements.find((element) => element.data.id === 'branch:0:task:2');
    const waiting = model.elements.find((element) => element.data.id === 'branch:0:task:3');
    const addTask = model.elements.find((element) => element.data.id === 'branch:0:add-task');
    const addTaskEdge = model.elements.find((element) => element.data.id === 'add-task-edge:0');

    expect(featureCommit).toMatchObject({
      data: { color: '#3977d4' }, classes: 'primary feature-owned', grabbable: false, pannable: true,
    });
    expect(forkEdge).toMatchObject({
      data: { source: 'primary:base', target: 'branch:0:fork', color: '#3977d4' },
      classes: 'fork-edge',
    });
    expect(checkpoint?.classes).toContain('checkpoint');
    expect(waiting?.classes).not.toContain('checkpoint');
    expect(addTask).toMatchObject({
      data: { label: '+', subtitle: 'Add task', featureId: 7, color: '#3977d4' },
      position: { x: 1010, y: 220 },
      classes: 'add-task',
    });
    expect(addTaskEdge).toMatchObject({ data: { source: 'branch:0:task:3', target: 'branch:0:add-task' } });
    expect(model.height).toBe(360);
  });

  it('renders a missing branch as a monochrome Cytoscape lane', () => {
    const component = new CytoscapeBranchGraphComponent();
    const missing = { ...lane(), exists: false };
    component.map = map(missing);
    component.lanes = [missing];

    const laneElements = component.graphModel().elements.filter((element) =>
      String(element.data.id).startsWith('branch:') || String(element.data.id).startsWith('fork-edge:'),
    );

    expect(laneElements.length).toBeGreaterThan(0);
    expect(laneElements.every((element) => String(element.classes).includes('missing'))).toBe(true);
  });
});

function map(feature: BranchLane): ProjectBranchMap {
  return {
    project: { id: 1, name: 'Project', repository_path: 'C:/repo', context: null, created_at: '', updated_at: '' },
    current_branch: 'main',
    primary_branch: 'main',
    primary_commits: [commit('feature', 'feat: index documents'), commit('base', 'Base commit')],
    branches: [feature],
  };
}

function lane(): BranchLane {
  return {
    name: 'feature/search',
    exists: true,
    is_current: false,
    is_primary: false,
    ahead: 1,
    behind: 0,
    fork_commit: commit('base', 'Base commit'),
    feature: {
      id: 7, project_id: 1, name: 'Search', branch_name: 'feature/search', base_branch: 'main',
      created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
    },
    tasks: [
      task(1, 'DONE', 'feat: index documents'),
      task(2, 'IN_REVIEW'),
      task(3, 'TODO'),
    ],
  };
}

function commit(sha: string, summary: string) {
  return { sha, short_sha: sha, summary, committed_at: '2026-09-05T00:00:00.000Z' };
}

function task(
  id: number,
  status: BranchLane['tasks'][number]['status'],
  commitSummary: string | null = null,
): BranchLane['tasks'][number] {
  return {
    id, title: `Task ${id}`, status, commit_summary: commitSummary,
    created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
  };
}
