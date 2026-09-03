import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { Project, StatusColumn, Task, TaskDetail, TaskRun, TaskStatus } from '../../models';
import { projectName, statusLabel, trackRun } from '../../task-view.utils';

@Component({ selector: 'task-detail-dialog', standalone: true, imports: [CommonModule], templateUrl: './task-detail-dialog.component.html' })
export class TaskDetailDialogComponent {
  @Input() task: Task | null = null;
  @Input() detail: TaskDetail | null = null;
  @Input({ required: true }) projects: readonly Project[] = [];
  @Input({ required: true }) columns: readonly StatusColumn[] = [];
  @Input({ required: true }) loading = false;
  @Input({ required: true }) pending = false;
  @Input() apiError = '';

  @Output() closed = new EventEmitter<void>();
  @Output() editRequested = new EventEmitter<Task>();
  @Output() deleteRequested = new EventEmitter<Task>();
  @Output() approveRequested = new EventEmitter<Task>();
  @Output() branchRemovalRequested = new EventEmitter<Task>();
  @Output() pushRequested = new EventEmitter<Task>();
  @Output() retryRequested = new EventEmitter<Task>();
  @Output() rejectRequested = new EventEmitter<Task>();

  readonly trackRun = trackRun;
  projectName(projectId: number): string { return projectName(this.projects, projectId); }
  statusLabel(value: TaskStatus): string { return statusLabel(this.columns, value); }
  canModify(task: Task): boolean {
    return !['CLAIMED', 'IN_PROGRESS', 'TESTING', 'PENDING_PUSH', 'PENDING_BRANCH_REMOVAL'].includes(task.status);
  }
  runLabel(_run: TaskRun, index: number, total: number): string { return `Attempt ${total - index}`; }
  hasOutput(value: string | null | undefined): boolean { return Boolean(value?.trim()); }
}
