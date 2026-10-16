import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import type { AgentModel, Feature, ModelEffort, Project, TaskDraft, TaskPriority } from '../../models';

@Component({ selector: 'task-editor-dialog', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './task-editor-dialog.component.html' })
export class TaskEditorDialogComponent {
  @Input({ required: true }) mode: 'create' | 'edit' = 'create';
  @Input({ required: true }) draft!: TaskDraft;
  @Input({ required: true }) projects: readonly Project[] = [];
  @Input({ required: true }) features: readonly Feature[] = [];
  @Input({ required: true }) priorities: readonly TaskPriority[] = [];
  @Input({ required: true }) models: readonly AgentModel[] = [];
  @Input({ required: true }) saving = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<void>();

  submit(form: NgForm): void {
    if (form.invalid || this.draft.project_id === null || this.saving) { form.control.markAllAsTouched(); return; }
    this.submitted.emit();
  }

  modelEffortLabel(effort: ModelEffort): string {
    const labels: Record<string, string> = {
      low: 'Low · Light',
      medium: 'Medium · Balanced',
      high: 'High',
      xhigh: 'Extra high',
      max: 'Max · Ultra',
      ultra: 'Ultra · Delegation',
    };
    return labels[effort] ?? effort;
  }

  availableEfforts(): readonly ModelEffort[] {
    return this.models.find((model) => model.id === this.draft.model_id)
      ?.supportedReasoningEfforts.map((effort) => effort.id) ?? [];
  }

  modelChanged(): void {
    const model = this.models.find((candidate) => candidate.id === this.draft.model_id);
    if (model === undefined) return;
    if (!model.supportedReasoningEfforts.some((effort) => effort.id === this.draft.model_effort)) {
      this.draft.model_effort = model.defaultReasoningEffort;
    }
  }

  projectFeatures(): Feature[] {
    return this.features.filter((feature) => feature.project_id === this.draft.project_id);
  }

  projectChanged(): void {
    this.draft.feature_id = this.projectFeatures()[0]?.id ?? null;
  }
}
