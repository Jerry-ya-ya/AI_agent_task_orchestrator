import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';

import type { FrontendConnectionDraft } from '../../models';

@Component({
  selector: 'frontend-connection-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './frontend-connection-dialog.component.html',
})
export class FrontendConnectionDialogComponent {
  @Input({ required: true }) draft!: FrontendConnectionDraft;
  @Input() mode: 'create' | 'edit' = 'create';
  @Input({ required: true }) saving = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<void>();

  submit(form: NgForm): void {
    if (form.invalid || this.saving) {
      form.control.markAllAsTouched();
      return;
    }
    this.submitted.emit();
  }
}
