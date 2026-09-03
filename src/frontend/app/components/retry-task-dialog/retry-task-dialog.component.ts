import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import type { ModelEffort, Task } from '../../models';

export interface RetryTaskRequest { prompt: string; modelEffort: ModelEffort; }

@Component({ selector: 'retry-task-dialog', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './retry-task-dialog.component.html' })
export class RetryTaskDialogComponent implements OnChanges {
  @Input({ required: true }) task!: Task;
  @Input({ required: true }) modelEfforts: readonly ModelEffort[] = [];
  @Input({ required: true }) pending = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<RetryTaskRequest>();
  prompt = '';
  modelEffort: ModelEffort = 'medium';

  ngOnChanges(): void { this.modelEffort = this.task?.model_effort ?? 'medium'; }
  submit(form: NgForm): void {
    if (form.invalid || this.pending) { form.control.markAllAsTouched(); return; }
    this.submitted.emit({ prompt: this.prompt.trim(), modelEffort: this.modelEffort });
  }
  modelEffortLabel(effort: ModelEffort): string { return effort === 'xhigh' ? 'Extra high' : `${effort[0].toUpperCase()}${effort.slice(1)}`; }
}
