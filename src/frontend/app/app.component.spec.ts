import '@angular/compiler';

import type { ChangeDetectorRef } from '@angular/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiService } from './api.service';
import { AppComponent } from './app.component';
import type { Project, Task, WorkerStatus } from './models';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AppComponent initialization', () => {
  it('loads board and worker data and schedules rendering without a user interaction', async () => {
    const project = exampleProject();
    const task = exampleTask();
    const worker: WorkerStatus = {
      running: true,
      busy: false,
      activeTaskId: null,
      agentAvailable: true,
      message: 'Worker idle.'
    };
    const api = {
      baseUrl: 'http://127.0.0.1:4317',
      getProjects: vi.fn(() => of([project])),
      getTasks: vi.fn(() => of([task])),
      getHealth: vi.fn(() => of({ ok: true, worker }))
    } as unknown as ApiService;
    const markForCheck = vi.fn();
    const changeDetector = { markForCheck } as unknown as ChangeDetectorRef;
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      1 as unknown as ReturnType<typeof setInterval>
    );

    const component = new AppComponent(api, changeDetector);
    component.ngOnInit();

    await vi.waitFor(() => {
      expect(component.projects).toEqual([project]);
      expect(component.tasks).toEqual([task]);
      expect(component.workerStatus).toEqual(worker);
      expect(component.loading).toBe(false);
      expect(component.connected).toBe(true);
      expect(markForCheck).toHaveBeenCalled();
    });
  });
});

function exampleProject(): Project {
  return {
    id: 1,
    name: 'Example',
    repository_path: 'C:\\Projects\\example',
    context: null,
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-08-31T00:00:00.000Z'
  };
}

function exampleTask(): Task {
  return {
    id: 7,
    project_id: 1,
    title: 'Load immediately',
    description: '',
    status: 'TODO',
    priority: 'MEDIUM',
    branch_name: null,
    worktree_path: null,
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-08-31T00:00:00.000Z',
    latest_run: null
  };
}
