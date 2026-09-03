import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';

@Component({ selector: 'retry-review-dialog', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './retry-review-dialog.component.html' })
export class RetryReviewDialogComponent {
  @Input({ required: true }) saving = false;
  @Input() apiError = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<string>();
  prompt = '';
  submit(form: NgForm): void {
    if (form.invalid || this.saving) { form.control.markAllAsTouched(); return; }
    this.submitted.emit(this.prompt.trim());
  }
}
