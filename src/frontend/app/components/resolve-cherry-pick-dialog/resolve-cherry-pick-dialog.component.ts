import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { AgentModel, ModelEffort, ModelId, Task } from '../../models';

export interface ConflictResolutionModel {
  modelId: ModelId;
  modelEffort: ModelEffort;
}

@Component({
  selector: 'resolve-cherry-pick-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './resolve-cherry-pick-dialog.component.html',
})
export class ResolveCherryPickDialogComponent implements OnChanges {
  @Input({ required: true }) task!: Task;
  @Input({ required: true }) models: readonly AgentModel[] = [];
  @Input({ required: true }) pending = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<ConflictResolutionModel>();

  modelId: ModelId = 'gpt-6.1-sol';
  modelEffort: ModelEffort = 'high';

  ngOnChanges(): void {
    this.modelId = this.task?.model_id ?? this.models.find((model) => model.isDefault)?.id ?? 'gpt-6.1-sol';
    this.modelEffort = this.task?.model_effort ?? 'high';
  }

  submit(): void {
    if (!this.pending) this.submitted.emit({ modelId: this.modelId, modelEffort: this.modelEffort });
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
