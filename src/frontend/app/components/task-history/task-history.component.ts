import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { Project, StatusColumn, Task, TaskStatus } from '../../models';
import { completedTaskHistory, latestTaskResult, projectName, statusLabel, trackTask } from '../../task-view.utils';

@Component({ selector: 'task-history', standalone: true, imports: [CommonModule], templateUrl: './task-history.component.html' })
export class TaskHistoryComponent {
  @Input({ required: true }) tasks: readonly Task[] = [];
  @Input({ required: true }) projects: readonly Project[] = [];
  @Input({ required: true }) columns: readonly StatusColumn[] = [];
  @Output() taskOpened = new EventEmitter<Task>();
  readonly trackTask = trackTask;
  history(): Task[] { return completedTaskHistory(this.tasks); }
  projectName(projectId: number): string { return projectName(this.projects, projectId); }
  latestResult(task: Task): string { return latestTaskResult(task); }
  statusLabel(value: TaskStatus): string { return statusLabel(this.columns, value); }
}
