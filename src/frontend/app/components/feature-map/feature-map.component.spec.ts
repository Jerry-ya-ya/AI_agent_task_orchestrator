import '@angular/compiler';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BranchLane, ProjectBranchMap } from '../../models';
import { FeatureMapComponent } from './feature-map.component';

describe('FeatureMapComponent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tracks refreshed project maps by project id', () => {
    const component = new FeatureMapComponent();
    const map = { project: { id: 12 } } as Parameters<FeatureMapComponent['trackProject']>[1];

    expect(component.trackProject(0, map)).toBe(12);
  });

  it('shows one selected project and preserves that selection across refreshed maps', () => {
    const component = new FeatureMapComponent();
    const first = projectMap(1, 'First');
    const second = projectMap(2, 'Second');
    component.maps = [first, second];

    expect(component.selectedMap()).toBe(first);
    component.selectProject('2');
    expect(component.selectedMap()).toBe(second);

    const refreshedSecond = projectMap(2, 'Second refreshed');
    component.maps = [projectMap(1, 'First refreshed'), refreshedSecond];
    expect(component.selectedProjectId).toBe(2);
    expect(component.selectedMap()).toBe(refreshedSecond);

    component.maps = [projectMap(1, 'First only')];
    expect(component.selectedProjectId).toBe(1);
  });

  it('restores and persists the selected project', () => {
    const storage = memoryStorage({ 'agentboard.featureMap.selectedProjectId': '2' });
    vi.stubGlobal('localStorage', storage);
    const component = new FeatureMapComponent();
    const first = projectMap(1, 'First');
    const second = projectMap(2, 'Second');

    component.maps = [first, second];
    expect(component.selectedMap()).toBe(second);

    component.selectProject('1');
    expect(storage.getItem('agentboard.featureMap.selectedProjectId')).toBe('1');
  });

  it('replaces a stored project that no longer exists', () => {
    const storage = memoryStorage({ 'agentboard.featureMap.selectedProjectId': '99' });
    vi.stubGlobal('localStorage', storage);
    const component = new FeatureMapComponent();

    component.maps = [projectMap(3, 'Available')];

    expect(component.selectedProjectId).toBe(3);
    expect(storage.getItem('agentboard.featureMap.selectedProjectId')).toBe('3');
  });

  it('places the youngest feature directly below main', () => {
    const component = new FeatureMapComponent();
    const older = lane(1, '2026-09-01T00:00:00.000Z');
    const younger = lane(2, '2026-09-06T00:00:00.000Z');
    const primary = { ...lane(3, '2026-08-01T00:00:00.000Z'), is_primary: true };
    const map = { project: { id: 1, name: 'Project', repository_path: 'C:/repo', context: null, created_at: '', updated_at: '' }, current_branch: 'main', primary_branch: 'main', primary_commits: [], branches: [older, primary, younger] };

    const sortedLanes = component.featureLanes(map);
    expect(sortedLanes.map((item) => item.feature?.id)).toEqual([2, 1]);
    expect(component.featureLanes(map)).toBe(sortedLanes);
  });

  it('emits a complete manual order when a branch moves', () => {
    const component = new FeatureMapComponent();
    const older = lane(1, '2026-09-01T00:00:00.000Z');
    const younger = lane(2, '2026-09-06T00:00:00.000Z');
    const map = { project: { id: 9, name: 'Project', repository_path: 'C:/repo', context: null, created_at: '', updated_at: '' }, current_branch: 'main', primary_branch: 'main', primary_commits: [], branches: [older, younger] };
    let emitted: { projectId: number; branchNames: string[] } | undefined;
    component.branchOrderChanged.subscribe((value) => { emitted = value; });

    component.moveBranch(map, older, -1);

    expect(emitted).toEqual({ projectId: 9, branchNames: ['feature/1', 'feature/2'] });

    const manuallyOrdered = [{ ...older, display_order: 0 }, { ...younger, display_order: 1 }];
    const newest = lane(3, '2026-09-07T00:00:00.000Z');
    expect(component.featureLanes({ ...map, branches: [...manuallyOrdered, newest] }).map((item) => item.name))
      .toEqual(['feature/3', 'feature/1', 'feature/2']);
  });
});

function lane(id: number, createdAt: string): BranchLane {
  return {
    name: `feature/${id}`, exists: true, is_current: false, is_primary: false,
    ahead: 1, behind: 0, fork_commit: null, tasks: [],
    feature: { id, project_id: 1, name: `Feature ${id}`, branch_name: `feature/${id}`, base_branch: 'main', created_at: createdAt, updated_at: createdAt },
  };
}

function projectMap(id: number, name: string): ProjectBranchMap {
  return {
    project: { id, name, repository_path: `C:/repo/${id}`, context: null, created_at: '', updated_at: '' },
    current_branch: 'main', primary_branch: 'main', primary_commits: [], branches: [],
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
