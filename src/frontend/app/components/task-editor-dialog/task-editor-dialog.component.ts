import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import type { Feature, ModelEffort, ModelId, Project, TaskDraft, TaskPriority } from '../../models';

@Component({ selector: 'task-editor-dialog', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './task-editor-dialog.component.html' })
export class TaskEditorDialogComponent {
  @Input({ required: true }) mode: 'create' | 'edit' = 'create';
  @Input({ required: true }) draft!: TaskDraft;
  @Input({ required: true }) projects: readonly Project[] = [];
  @Input({ required: true }) features: readonly Feature[] = [];
  @Input({ required: true }) priorities: readonly TaskPriority[] = [];
  @Input({ required: true }) modelIds: readonly ModelId[] = [];
  @Input({ required: true }) modelEfforts: readonly ModelEffort[] = [];
  @Input({ required: true }) saving = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<void>();

  submit(form: NgForm): void {
    if (form.invalid || this.draft.project_id === null || this.saving) { form.control.markAllAsTouched(); return; }
    this.submitted.emit();
  }

  modelEffortLabel(effort: ModelEffort): string {
    const labels: Record<ModelEffort, string> = {
      low: 'Low · Light',
      medium: 'Medium · Balanced',
      high: 'High',
      xhigh: 'Extra high',
      max: 'Max · Ultra',
    };
    return labels[effort];
  }

  modelLabel(modelId: ModelId): string {
    const labels: Record<ModelId, string> = {
      'gpt-6-luna': 'GPT-6 Luna',
      'gpt-6.1-sol': 'GPT-6.1 Sol',
      'gpt-6-astra': 'GPT-6 Astra',
    };
    return labels[modelId];
  }

  projectFeatures(): Feature[] {
    return this.features.filter((feature) => feature.project_id === this.draft.project_id);
  }

  projectChanged(): void {
    this.draft.feature_id = this.projectFeatures()[0]?.id ?? null;
  }
}
