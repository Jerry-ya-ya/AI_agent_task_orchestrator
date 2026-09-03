import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { Project, StatusColumn, Task, TaskStatus } from '../../models';
import { latestTaskResult, projectName, statusLabel, tasksForStatus, trackTask } from '../../task-view.utils';

@Component({ selector: 'task-board', standalone: true, imports: [CommonModule], templateUrl: './task-board.component.html' })
export class TaskBoardComponent {
  @Input({ required: true }) columns: readonly StatusColumn[] = [];
  @Input({ required: true }) tasks: readonly Task[] = [];
  @Input({ required: true }) projects: readonly Project[] = [];
  @Input({ required: true }) pendingTaskIds: ReadonlySet<number> = new Set();
  @Input({ required: true }) loading = false;

  @Output() taskOpened = new EventEmitter<Task>();
  @Output() pauseToggled = new EventEmitter<Task>();
  @Output() branchRemovalRequested = new EventEmitter<Task>();
  @Output() pushRequested = new EventEmitter<Task>();
  @Output() reviewRetryRequested = new EventEmitter<Task>();
  @Output() rejectRequested = new EventEmitter<Task>();
  @Output() approveRequested = new EventEmitter<Task>();
  @Output() retryRequested = new EventEmitter<Task>();

  readonly trackTask = trackTask;
  tasksFor(status: TaskStatus): Task[] { return tasksForStatus(this.tasks, status); }
  projectName(projectId: number): string { return projectName(this.projects, projectId); }
  latestResult(task: Task): string { return latestTaskResult(task); }
  statusLabel(status: TaskStatus): string { return statusLabel(this.columns, status); }
  isPending(taskId: number): boolean { return this.pendingTaskIds.has(taskId); }
}
