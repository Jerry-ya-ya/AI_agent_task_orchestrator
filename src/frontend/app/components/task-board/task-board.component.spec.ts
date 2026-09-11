import '@angular/compiler';

import { describe, expect, it } from 'vitest';

import type { Task, TaskStatus } from '../../models';
import { TaskBoardComponent } from './task-board.component';

describe('TaskBoardComponent', () => {
  it.each(['DONE', 'REJECTED', 'FAILED'] as const)('shows only the five newest %s tasks', (status) => {
    const component = new TaskBoardComponent();
    component.tasks = Array.from({ length: 7 }, (_value, index) => task(index + 1, status));

    expect(component.tasksFor(status).map((item) => item.id)).toEqual([7, 6, 5, 4, 3]);
    expect(component.totalTasksFor(status)).toBe(7);
    expect(component.hiddenTaskCount(status)).toBe(2);
  });

  it('does not limit active task statuses', () => {
    const component = new TaskBoardComponent();
    component.tasks = Array.from({ length: 7 }, (_value, index) => task(index + 1, 'TODO'));

    expect(component.tasksFor('TODO')).toHaveLength(7);
    expect(component.hiddenTaskCount('TODO')).toBe(0);
  });
});

function task(id: number, status: TaskStatus): Task {
  const timestamp = `2026-09-${String(id).padStart(2, '0')}T00:00:00.000Z`;
  return {
    id,
    project_id: 1,
    feature_id: 1,
    title: `Task ${id}`,
    description: '',
    status,
    priority: 'MEDIUM',
    model_effort: 'medium',
    agent_mode: 'implementation',
    retry_prompt: null,
    branch_name: 'feature/example',
    worktree_path: null,
    base_branch: 'main',
    commit_summary: null,
    publish_commit_sha: null,
    source_task_id: null,
    is_rejected: status === 'REJECTED',
    is_paused: false,
    created_at: timestamp,
    updated_at: timestamp,
    latest_run: null,
  };
}
