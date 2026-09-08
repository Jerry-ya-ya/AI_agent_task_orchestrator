import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { ModelEffort, Task } from '../../models';

@Component({
  selector: 'resolve-rebase-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './resolve-rebase-dialog.component.html',
})
export class ResolveRebaseDialogComponent implements OnChanges {
  @Input({ required: true }) task!: Task;
  @Input({ required: true }) modelEfforts: readonly ModelEffort[] = [];
  @Input({ required: true }) pending = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<ModelEffort>();

  modelEffort: ModelEffort = 'high';

  ngOnChanges(): void {
    this.modelEffort = this.task?.model_effort ?? 'high';
  }

  submit(): void {
    if (!this.pending) this.submitted.emit(this.modelEffort);
  }

  modelEffortLabel(effort: ModelEffort): string {
    return effort === 'xhigh' ? 'Extra high' : `${effort[0]?.toUpperCase()}${effort.slice(1)}`;
  }
}
