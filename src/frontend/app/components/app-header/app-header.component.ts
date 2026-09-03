import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { WorkerStatus } from '../../models';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app-header.component.html',
  styles: `
    .window-control {
      -webkit-app-region: no-drag;
      pointer-events: auto;
    }
  `
})
export class AppHeaderComponent {
  @Input({ required: true }) connected = false;
  @Input({ required: true }) apiBaseUrl = '';
  @Input() workerStatus: WorkerStatus | null = null;
  @Input({ required: true }) projectCount = 0;

  @Output() createProject = new EventEmitter<void>();
  @Output() createTask = new EventEmitter<void>();
  @Output() minimizeApplication = new EventEmitter<void>();
  @Output() closeApplication = new EventEmitter<void>();

  workerStateLabel(): string {
    if (!this.connected) return 'Worker unknown';
    if (this.workerStatus === null) return 'Worker status unavailable';
    if (!this.workerStatus.running) return 'Worker stopped';
    if (!this.workerStatus.agentAvailable) return 'Agent unavailable';
    if (this.workerStatus.busy) {
      return this.workerStatus.activeTaskId === null
        ? 'Worker busy'
        : `Running task #${this.workerStatus.activeTaskId}`;
    }
    return 'Worker idle';
  }

  workerStateTitle(): string {
    return this.workerStatus?.message || 'Worker health is not available.';
  }

  workerReady(): boolean {
    return Boolean(this.workerStatus?.agentAvailable && this.workerStatus.running);
  }

  workerWarning(): boolean {
    return Boolean(this.workerStatus && (!this.workerStatus.agentAvailable || !this.workerStatus.running));
  }
}
