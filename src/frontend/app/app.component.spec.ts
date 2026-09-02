import '@angular/compiler';

import type { ChangeDetectorRef } from '@angular/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiService } from './api.service';
import { AppComponent } from './app.component';
import type { AgentUsage, Project, Task, WorkerStatus } from './models';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AppComponent initialization', () => {
  it('closes the Electron window from the title-bar close control', () => {
    const api = { baseUrl: 'http://127.0.0.1:4317' } as unknown as ApiService;
    const changeDetector = { markForCheck: vi.fn() } as unknown as ChangeDetectorRef;
    const component = new AppComponent(api, changeDetector);
    const close = vi.fn();
    vi.stubGlobal('window', { desktopWindow: { close } });

    component.closeApplication();

    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the browser page when the desktop bridge is unavailable', () => {
    const api = { baseUrl: 'http://127.0.0.1:4317' } as unknown as ApiService;
    const changeDetector = { markForCheck: vi.fn() } as unknown as ChangeDetectorRef;
    const component = new AppComponent(api, changeDetector);
    const close = vi.fn();
    vi.stubGlobal('window', { close });

    component.closeApplication();

    expect(close).toHaveBeenCalledOnce();
  });

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
    const usage: AgentUsage = {
      available: true,
      planType: 'plus',
      primary: { remainingPercent: 75, usedPercent: 25, windowDurationMins: 300, resetsAt: null },
      secondary: null,
      resetCredits: 0,
      checkedAt: '2026-08-31T00:00:00.000Z',
      message: 'Codex usage is available.'
    };
    const api = {
      baseUrl: 'http://127.0.0.1:4317',
      getProjects: vi.fn(() => of([project])),
      getTasks: vi.fn(() => of([task])),
      getHealth: vi.fn(() => of({ ok: true, worker })),
      getAgentUsage: vi.fn(() => of(usage))
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
      expect(component.agentUsage).toEqual(usage);
      expect(component.loading).toBe(false);
      expect(component.connected).toBe(true);
      expect(markForCheck).toHaveBeenCalled();
    });
  });

  it('shows only completed and failed tasks in newest-first history order', () => {
    const api = { baseUrl: 'http://127.0.0.1:4317' } as unknown as ApiService;
    const changeDetector = { markForCheck: vi.fn() } as unknown as ChangeDetectorRef;
    const component = new AppComponent(api, changeDetector);
    component.tasks = [
      exampleTask({ id: 1, status: 'DONE', updated_at: '2026-08-30T08:00:00.000Z' }),
      exampleTask({ id: 2, status: 'TODO', updated_at: '2026-08-31T09:00:00.000Z' }),
      exampleTask({ id: 3, status: 'FAILED', updated_at: '2026-08-31T08:00:00.000Z' }),
      exampleTask({ id: 4, status: 'IN_REVIEW', updated_at: '2026-08-31T10:00:00.000Z' }),
    ];

    expect(component.taskHistory().map((task) => task.id)).toEqual([3, 1]);
  });

  it('hides the internal CLAIMED state and exposes branch cleanup between push and done', () => {
    const api = { baseUrl: 'http://127.0.0.1:4317' } as unknown as ApiService;
    const changeDetector = { markForCheck: vi.fn() } as unknown as ChangeDetectorRef;
    const component = new AppComponent(api, changeDetector);

    expect(component.columns.map((column) => column.status)).not.toContain('CLAIMED');
    expect(component.columns.map((column) => column.status)).toEqual([
      'TODO',
      'IN_PROGRESS',
      'TESTING',
      'IN_REVIEW',
      'PENDING_PUSH',
      'PENDING_BRANCH_REMOVAL',
      'DONE',
      'FAILED',
    ]);
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

function exampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    project_id: 1,
    title: 'Load immediately',
    description: '',
    status: 'TODO',
    priority: 'MEDIUM',
    model_effort: 'medium',
    branch_name: null,
    worktree_path: null,
    base_branch: null,
    commit_summary: null,
    is_paused: false,
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-08-31T00:00:00.000Z',
    latest_run: null,
    ...overrides
  };
}
