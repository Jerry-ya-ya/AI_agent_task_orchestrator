import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { Project, StatusColumn, Task, TaskDetail, TaskRun, TaskStatus } from '../../models';
import { projectName, statusLabel, trackRun } from '../../task-view.utils';
import { parseTaskRunDiff, type TaskDiffFile } from './task-diff.utils';

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
  @Output() reviewStarted = new EventEmitter<Task>();
  @Output() reviewExited = new EventEmitter<Task>();
  @Output() branchRemovalRequested = new EventEmitter<Task>();
  @Output() pushRequested = new EventEmitter<Task>();
  @Output() cherryPickResolutionRequested = new EventEmitter<Task>();
  @Output() retryRequested = new EventEmitter<Task>();
  @Output() rejectRequested = new EventEmitter<Task>();

  readonly trackRun = trackRun;
  private readonly diffCache = new Map<number, { source: string; files: TaskDiffFile[] }>();
  projectName(projectId: number): string { return projectName(this.projects, projectId); }
  statusLabel(value: TaskStatus): string { return statusLabel(this.columns, value); }
  canModify(task: Task): boolean {
    return !['CLAIMED', 'IN_PROGRESS', 'TESTING', 'REVIEWING', 'PENDING_PUSH', 'CHERRY_PICK_CONFLICT', 'PENDING_BRANCH_REMOVAL'].includes(task.status);
  }
  runLabel(run: TaskRun, index: number, total: number): string {
    return `${this.diffFiles(run).length > 0 ? 'Commit' : 'Attempt'} ${total - index}`;
  }
  hasOutput(value: string | null | undefined): boolean { return Boolean(value?.trim()); }
  diffFiles(run: TaskRun): TaskDiffFile[] {
    const source = `${run.file_diff}\0${run.code_diff}`;
    const cached = this.diffCache.get(run.id);
    if (cached?.source === source) return cached.files;
    const files = parseTaskRunDiff(run.code_diff, run.file_diff);
    this.diffCache.set(run.id, { source, files });
    return files;
  }
  trackDiffFile(index: number, file: TaskDiffFile): string { return `${index}:${file.path}`; }
}
