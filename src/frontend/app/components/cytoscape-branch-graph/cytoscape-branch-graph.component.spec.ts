import '@angular/compiler';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BranchLane, ProjectBranchMap } from '../../models';
import { CytoscapeBranchGraphComponent } from './cytoscape-branch-graph.component';

describe('CytoscapeBranchGraphComponent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses normal zoom speed by default and accepts supported zoom multipliers', () => {
    const component = new CytoscapeBranchGraphComponent();

    expect(component.zoomSensitivity).toBe(1);
    component.setZoomSensitivity('3');
    expect(component.zoomSensitivity).toBe(3);
    component.setZoomSensitivity('4');
    expect(component.zoomSensitivity).toBe(3);
  });

  it('renders a main-only repository history without requiring a Feature task', () => {
    const component = new CytoscapeBranchGraphComponent();
    component.map = {
      project: { id: 1, name: 'Main only', repository_path: 'C:/repo', context: '', created_at: '', updated_at: '' },
      current_branch: 'main',
      primary_branch: 'main',
      primary_commits: [{ sha: 'first', short_sha: 'first', summary: 'Initial commit', committed_at: '2026-09-19T00:00:00.000Z' }],
      branches: [{ name: 'main', exists: true, is_current: true, is_primary: true, ahead: null, behind: null, fork_commit: null, feature: null, tasks: [] }],
    };
    component.lanes = [];

    const model = component.graphModel();

    expect(model.elements).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({ id: 'primary:first', label: 'Initial commit' }),
    }));
  });

  it('restores and persists the zoom multiplier separately for each project', () => {
    const storage = memoryStorage({ 'agentboard.featureMap.zoomSensitivity.1': '3' });
    vi.stubGlobal('localStorage', storage);
    const component = new CytoscapeBranchGraphComponent();
    const feature = lane();

    component.map = map(feature);
    expect(component.zoomSensitivity).toBe(3);

    component.setZoomSensitivity('2');
    expect(storage.getItem('agentboard.featureMap.zoomSensitivity.1')).toBe('2');

    component.map = { ...map(feature), project: { ...map(feature).project, id: 2 } };
    expect(component.zoomSensitivity).toBe(1);
  });

  it('builds task history to the left of a pointer-anchored branch head', () => {
    const component = new CytoscapeBranchGraphComponent();
    const feature = lane();
    component.map = map(feature);
    component.lanes = [feature];

    const model = component.graphModel();
    const featureCommit = model.elements.find((element) => element.data.id === 'primary:feature');
    const forkEdge = model.elements.find((element) => element.data.id === 'fork-edge:0');
    const checkpoint = model.elements.find((element) => element.data.id === 'branch:0:task:2');
    const waiting = model.elements.find((element) => element.data.id === 'branch:0:task:3');
    const actionMenu = model.elements.find((element) => element.data.id === 'branch:0:pointer');
    const addTask = model.elements.find((element) => element.data.id === 'branch:0:action:add-task');
    const resetBranch = model.elements.find((element) => element.data.id === 'branch:0:action:reset-main');
    const deleteMenu = model.elements.find((element) => element.data.id === 'branch:0:action:delete');
    const deleteGit = model.elements.find((element) => element.data.id === 'branch:0:action:delete-git');
    const deleteDatabase = model.elements.find((element) => element.data.id === 'branch:0:action:delete-database');
    const pointerEdge = model.elements.find((element) => element.data.id === 'pointer-edge:0');

    expect(featureCommit).toMatchObject({
      data: { color: '#3977d4' }, classes: 'primary feature-owned', grabbable: false, pannable: true,
    });
    expect(forkEdge).toMatchObject({
      data: { source: 'primary:base', target: 'branch:0:pointer', color: '#3977d4' },
      classes: 'fork-edge',
    });
    expect(checkpoint?.classes).toContain('checkpoint');
    expect(waiting?.classes).not.toContain('checkpoint');
    expect(actionMenu).toMatchObject({
      data: { label: 'HEAD +', featureId: 7, color: '#3977d4' },
      position: { x: 820, y: 220 },
      classes: 'branch-pointer branch-actions',
    });
    expect(addTask).toMatchObject({
      data: { label: '+ Task', subtitle: 'Create task', featureId: 7, color: '#3977d4' },
      position: { x: 942, y: 164 },
    });
    expect(String(addTask?.classes)).toContain('branch-action-collapsed');
    expect(resetBranch).toMatchObject({
      data: { label: '↺ main', subtitle: 'Reset branch pointer', featureId: 7, color: '#3977d4' },
      position: { x: 942, y: 220 },
    });
    expect(String(resetBranch?.classes)).toContain('branch-action-collapsed');
    expect(deleteMenu).toMatchObject({
      data: { label: 'Delete ›', featureId: 7 },
      position: { x: 942, y: 276 },
    });
    expect(deleteGit).toMatchObject({ position: { x: 1058, y: 252 } });
    expect(deleteDatabase).toMatchObject({ position: { x: 1058, y: 300 } });
    expect(String(deleteGit?.classes)).toContain('branch-action-collapsed');
    expect(String(deleteDatabase?.classes)).toContain('branch-action-collapsed');
    expect(pointerEdge).toMatchObject({ data: { source: 'branch:0:task:3', target: 'branch:0:pointer' } });
    expect(model.elements.find((element) => element.data.id === 'primary:base')?.position).toEqual({ x: 820, y: 72 });
    expect(model.elements.find((element) => element.data.id === 'branch:0:task:1')?.position).toEqual({ x: 250, y: 220 });
    expect(model.elements.find((element) => element.data.id === 'branch:0:task:3')?.position).toEqual({ x: 630, y: 220 });

    (component as unknown as { toggleBranchActions(featureId: number): void }).toggleBranchActions(7);
    const expandedModel = component.graphModel();
    const expandedActions = expandedModel.elements.filter((element) =>
      String(element.classes).includes('branch-action-menu-item'),
    );
    expect(expandedActions.length).toBe(6);
    expect(expandedActions.every((element) => !String(element.classes).includes('branch-action-collapsed'))).toBe(true);

    (component as unknown as { toggleDeleteActions(featureId: number): void }).toggleDeleteActions(7);
    const deleteActions = component.graphModel().elements.filter((element) =>
      String(element.classes).includes('branch-delete-menu-item'),
    );
    expect(deleteActions.length).toBe(4);
    expect(deleteActions.every((element) => !String(element.classes).includes('branch-action-collapsed'))).toBe(true);
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

  it('adds a nested Git deletion action to managed legacy branches without a Feature record', () => {
    const component = new CytoscapeBranchGraphComponent();
    const legacy = { ...lane(), name: 'agent/legacy', feature: null, tasks: [] };
    component.map = map(legacy);
    component.lanes = [legacy];

    const collapsed = component.graphModel().elements;
    expect(collapsed.find((element) => element.data.id === 'branch:0:pointer')).toMatchObject({
      data: { label: 'HEAD +', legacyBranchName: 'agent/legacy', projectId: 1 },
      classes: 'branch-pointer branch-actions',
    });
    expect(String(collapsed.find((element) => element.data.id === 'branch:0:action:delete-legacy')?.classes))
      .toContain('branch-action-collapsed');

    (component as unknown as { toggleLegacyBranchActions(branchName: string): void })
      .toggleLegacyBranchActions('agent/legacy');
    let expanded = component.graphModel().elements;
    expect(String(expanded.find((element) => element.data.id === 'branch:0:action:delete-legacy')?.classes))
      .not.toContain('branch-action-collapsed');
    expect(String(expanded.find((element) => element.data.id === 'branch:0:action:delete-legacy-git')?.classes))
      .toContain('branch-action-collapsed');

    (component as unknown as { toggleLegacyDeleteActions(branchName: string): void })
      .toggleLegacyDeleteActions('agent/legacy');
    expanded = component.graphModel().elements;
    expect(String(expanded.find((element) => element.data.id === 'branch:0:action:delete-legacy-git')?.classes))
      .not.toContain('branch-action-collapsed');
    expect(expanded.some((element) => String(element.data.id).includes('delete-database'))).toBe(false);
  });

  it('locks pointer reset actions while a branch has protected Review work', () => {
    const component = new CytoscapeBranchGraphComponent();
    const protectedLane = { ...lane(), tasks: [task(8, 'PENDING_PUSH')] };
    component.map = map(protectedLane);
    component.lanes = [protectedLane];

    expect(component.hasProtectedPointerTasks()).toBe(true);
    expect(component.hasResettableBranches()).toBe(true);
    const resetAction = component.graphModel().elements.find((element) =>
      element.data.id === 'branch:0:action:reset-main',
    );
    expect(resetAction).toMatchObject({ data: { label: 'Review locked', resetBlocked: 1 } });
    expect(String(resetAction?.classes)).toContain('branch-action-disabled');
  });

  it('anchors reset branches to a rightmost pointer and keeps all task history before it', () => {
    const component = new CytoscapeBranchGraphComponent();
    const resetLane = {
      ...lane(),
      fork_commit: commit('feature', 'feat: index documents'),
      feature: { ...lane().feature!, pointer_reset_task_id: 9 },
      tasks: [task(9, 'DONE', null, true), task(10, 'TODO')],
    };
    component.map = map(resetLane);
    component.lanes = [resetLane];

    const elements = component.graphModel().elements;
    expect(elements.find((element) => element.data.id === 'primary:base')?.position).toEqual({ x: 440, y: 72 });
    expect(elements.find((element) => element.data.id === 'primary:feature')?.position).toEqual({ x: 630, y: 72 });
    expect(elements.find((element) => element.data.id === 'fork-edge:0')).toMatchObject({
      data: { source: 'primary:feature', target: 'branch:0:reset-pointer' },
    });
    expect(elements.find((element) => element.data.id === 'branch:0:pointer')).toMatchObject({
      data: { label: 'HEAD +', subtitle: 'current branch end' },
      position: { x: 1010, y: 220 },
    });
    expect(elements.find((element) => element.data.id === 'branch:0:task:9')?.position).toEqual({ x: 440, y: 220 });
    expect(elements.find((element) => element.data.id === 'branch:0:reset-pointer')).toMatchObject({
      data: { label: 'POINTER', subtitle: 'reset to feature · feat: index documents' },
      position: { x: 630, y: 220 },
      classes: 'branch-pointer reset-pointer',
    });
    expect(elements.find((element) => element.data.id === 'branch:0:task:10')?.position).toEqual({ x: 820, y: 220 });
    expect(elements.find((element) => element.data.id === 'reset-pointer-edge:0')).toMatchObject({
      data: { source: 'branch:0:task:9', target: 'branch:0:reset-pointer' },
    });
    expect(elements.find((element) => element.data.id === 'task-edge:0:10')).toMatchObject({
      data: { source: 'branch:0:reset-pointer', target: 'branch:0:task:10' },
    });
    expect(elements.find((element) => element.data.id === 'pointer-edge:0')).toMatchObject({
      data: { source: 'branch:0:task:10', target: 'branch:0:pointer' },
    });
    expect(elements.find((element) => element.data.id === 'primary:feature')?.position?.x)
      .toBe(elements.find((element) => element.data.id === 'branch:0:reset-pointer')?.position?.x);
    expect(String(elements.find((element) => element.data.id === 'branch:0:task:9')?.classes)).toContain('historical');
    expect(elements.filter((element) => element.data.source !== undefined)
      .every((element) => !String(element.classes).includes('historical'))).toBe(true);
  });

  it('keeps branch labels at the left viewport edge while preserving their vertical lane position', () => {
    const component = new CytoscapeBranchGraphComponent();
    const labelPositions = new Map<string, { x: number; y: number }>([
      ['first', { x: 86, y: 220 }],
      ['second', { x: 86, y: 372 }],
    ]);
    const labels = [...labelPositions.entries()].map(([id, position]) => ({
      position: (axis: 'x', value: number) => {
        if (axis === 'x') position.x = value;
      },
      id,
    }));
    (component as unknown as { graph: unknown }).graph = {
      zoom: () => 2,
      pan: () => ({ x: -300, y: -100 }),
      nodes: (selector: string) => {
        expect(selector).toBe('node.branch-label');
        return { forEach: (callback: (label: (typeof labels)[number]) => void) => labels.forEach(callback) };
      },
    };

    (component as unknown as { syncBranchLabels: () => void }).syncBranchLabels();

    expect(labelPositions.get('first')).toEqual({ x: 193, y: 220 });
    expect(labelPositions.get('second')).toEqual({ x: 193, y: 372 });
    expect((193 * 2) - 300).toBe(86);
  });

  it('preserves a valid viewport while the graph container resizes', () => {
    const component = new CytoscapeBranchGraphComponent();
    const calls: Array<[string, unknown?]> = [];
    let zoom = 1.25;
    let pan = { x: -180, y: 42 };
    (component as unknown as { graph: unknown }).graph = {
      zoom: (value?: number) => {
        if (value !== undefined) {
          zoom = value;
          calls.push(['zoom', value]);
        }
        return zoom;
      },
      pan: (value?: { x: number; y: number }) => {
        if (value !== undefined) {
          pan = value;
          calls.push(['pan', value]);
        }
        return pan;
      },
      resize: () => calls.push(['resize']),
      stop: () => calls.push(['stop']),
    };

    (component as unknown as { resizeGraphPreservingViewport(): void }).resizeGraphPreservingViewport();

    expect(calls).toEqual([
      ['resize'],
      ['stop'],
      ['zoom', 1.25],
      ['pan', { x: -180, y: 42 }],
    ]);
  });

  it('normalizes invalid or out-of-range viewport values before applying them', () => {
    const component = new CytoscapeBranchGraphComponent();
    const normalize = (viewport: { zoom: number; pan: { x: number; y: number } }) =>
      (component as unknown as { normalizeViewport(value: typeof viewport): typeof viewport }).normalizeViewport(viewport);

    expect(normalize({ zoom: 99, pan: { x: Number.NaN, y: Number.POSITIVE_INFINITY } }))
      .toEqual({ zoom: 2, pan: { x: 24, y: 30 } });
    expect(normalize({ zoom: Number.NaN, pan: { x: 5, y: 6 } }))
      .toEqual({ zoom: 0.88, pan: { x: 5, y: 6 } });
  });
});

function map(feature: BranchLane): ProjectBranchMap {
  return {
    project: { id: 1, name: 'Project', repository_path: 'C:/repo', context: null, created_at: '', updated_at: '' },
    current_branch: 'main',
    primary_branch: 'main',
    primary_commits: [commit('base', 'Base commit'), commit('feature', 'feat: index documents')],
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
      id: 7, project_id: 1, name: 'Search', branch_name: 'feature/search', base_branch: 'main', pointer_reset_task_id: null,
      created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
    },
    tasks: [
      task(1, 'DONE', 'feat: index documents'),
      task(2, 'DONE'),
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
  isBeforePointerReset = false,
): BranchLane['tasks'][number] {
  return {
    id, title: `Task ${id}`, status, commit_summary: commitSummary,
    is_before_pointer_reset: isBeforePointerReset,
    created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
  };
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}
