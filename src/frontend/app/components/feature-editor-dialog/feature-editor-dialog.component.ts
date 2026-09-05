import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import type { FeatureDraft, Project } from '../../models';

@Component({
  selector: 'feature-editor-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './feature-editor-dialog.component.html',
})
export class FeatureEditorDialogComponent {
  @Input({ required: true }) draft!: FeatureDraft;
  @Input({ required: true }) projects: readonly Project[] = [];
  @Input({ required: true }) saving = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<void>();

  submit(form: NgForm): void {
    if (form.invalid || this.draft.project_id === null || this.saving) {
      form.control.markAllAsTouched();
      return;
    }
    this.submitted.emit();
  }
}
