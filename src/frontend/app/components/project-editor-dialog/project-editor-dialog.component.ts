import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import type { ProjectDraft } from '../../models';

@Component({ selector: 'project-editor-dialog', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './project-editor-dialog.component.html' })
export class ProjectEditorDialogComponent {
  @Input({ required: true }) draft!: ProjectDraft;
  @Input({ required: true }) saving = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<void>();

  choosingRepository = false;

  get canChooseRepository(): boolean {
    return globalThis.window?.desktopWindow?.chooseRepository !== undefined;
  }

  submit(form: NgForm): void {
    if (form.invalid || this.saving) { form.control.markAllAsTouched(); return; }
    this.submitted.emit();
  }

  async chooseRepository(): Promise<void> {
    const chooser = globalThis.window?.desktopWindow?.chooseRepository;
    if (chooser === undefined || this.choosingRepository) return;

    this.choosingRepository = true;
    try {
      const selectedPath = await chooser(this.draft.repository_path);
      if (selectedPath !== null) this.draft.repository_path = selectedPath;
    } finally {
      this.choosingRepository = false;
    }
  }
}
