import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import type { AgentModel, ModelEffort, ModelId, Task } from '../../models';

export interface RetryTaskRequest { prompt: string; modelId: ModelId; modelEffort: ModelEffort; }

@Component({ selector: 'retry-task-dialog', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './retry-task-dialog.component.html' })
export class RetryTaskDialogComponent implements OnChanges {
  @Input({ required: true }) task!: Task;
  @Input({ required: true }) models: readonly AgentModel[] = [];
  @Input({ required: true }) pending = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<RetryTaskRequest>();
  prompt = '';
  modelId: ModelId = 'gpt-6.1-sol';
  modelEffort: ModelEffort = 'low';

  ngOnChanges(): void {
    this.modelId = this.task?.model_id ?? this.models.find((model) => model.isDefault)?.id ?? 'gpt-6.1-sol';
    this.modelEffort = this.task?.model_effort ?? this.selectedModel()?.defaultReasoningEffort ?? 'low';
  }
  submit(form: NgForm): void {
    if (form.invalid || this.pending) { form.control.markAllAsTouched(); return; }
    this.submitted.emit({ prompt: this.prompt.trim(), modelId: this.modelId, modelEffort: this.modelEffort });
  }
  selectableModels(): readonly AgentModel[] {
    if (this.models.some((model) => model.id === this.modelId)) return this.models;
    return [{ id: this.modelId, displayName: this.modelId, description: '', isDefault: false, defaultReasoningEffort: this.modelEffort, supportedReasoningEfforts: [{ id: this.modelEffort, description: '' }] }, ...this.models];
  }
  availableEfforts(): readonly ModelEffort[] {
    return this.selectedModel()?.supportedReasoningEfforts.map((effort) => effort.id) ?? [this.modelEffort];
  }
  modelChanged(): void {
    const model = this.selectedModel();
    if (model !== undefined && !model.supportedReasoningEfforts.some((effort) => effort.id === this.modelEffort)) {
      this.modelEffort = model.defaultReasoningEffort;
    }
  }
  modelEffortLabel(effort: ModelEffort): string {
    return ({ low: 'Low · Light', medium: 'Medium · Balanced', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra · Delegation' } as Record<string, string>)[effort] ?? effort;
  }
  private selectedModel(): AgentModel | undefined {
    return this.models.find((model) => model.id === this.modelId);
  }
}
