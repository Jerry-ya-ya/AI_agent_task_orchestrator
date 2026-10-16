import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import type { ModelEffort, ModelId, Task } from '../../models';

export interface RetryTaskRequest { prompt: string; modelId: ModelId; modelEffort: ModelEffort; }

@Component({ selector: 'retry-task-dialog', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './retry-task-dialog.component.html' })
export class RetryTaskDialogComponent implements OnChanges {
  @Input({ required: true }) task!: Task;
  @Input({ required: true }) modelIds: readonly ModelId[] = [];
  @Input({ required: true }) modelEfforts: readonly ModelEffort[] = [];
  @Input({ required: true }) pending = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<RetryTaskRequest>();
  prompt = '';
  modelId: ModelId = 'gpt-6-luna';
  modelEffort: ModelEffort = 'medium';

  ngOnChanges(): void {
    this.modelId = this.task?.model_id ?? 'gpt-6-luna';
    this.modelEffort = this.task?.model_effort ?? 'medium';
  }
  submit(form: NgForm): void {
    if (form.invalid || this.pending) { form.control.markAllAsTouched(); return; }
    this.submitted.emit({ prompt: this.prompt.trim(), modelId: this.modelId, modelEffort: this.modelEffort });
  }
  modelLabel(modelId: ModelId): string {
    return ({ 'gpt-6-luna': 'GPT-6 Luna', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6-astra': 'GPT-6 Astra' })[modelId];
  }
  modelEffortLabel(effort: ModelEffort): string {
    return ({ low: 'Low · Light', medium: 'Medium · Balanced', high: 'High', xhigh: 'Extra high', max: 'Max · Ultra' })[effort];
  }
}
