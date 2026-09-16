import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { AgentUsage, WorkerStatus } from '../../models';
import { HeaderUsageComponent } from '../header-usage/header-usage.component';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, HeaderUsageComponent],
  templateUrl: './app-header.component.html',
  styles: `
    button {
      -webkit-app-region: no-drag;
      pointer-events: auto;
    }
  `
})
export class AppHeaderComponent {
  @Input({ required: true }) connected = false;
  @Input({ required: true }) apiBaseUrl = '';
  @Input() workerStatus: WorkerStatus | null = null;
  @Input() agentUsage: AgentUsage | null = null;
  @Input({ required: true }) projectCount = 0;

  @Output() createProject = new EventEmitter<void>();
  @Output() createTask = new EventEmitter<void>();
  @Output() workerToggled = new EventEmitter<void>();
  @Output() quotaLoopToggled = new EventEmitter<void>();
  @Output() minimizeApplication = new EventEmitter<void>();
  @Output() closeApplication = new EventEmitter<void>();

  workerStateLabel(): string {
    if (!this.connected) return 'Worker unknown';
    if (this.workerStatus === null) return 'Worker status unavailable';
    if (!this.workerStatus.running) return 'Worker stopped';
    if (this.workerStatus.paused) {
      return this.workerStatus.busy && this.workerStatus.activeTaskId !== null
        ? `Finishing task #${this.workerStatus.activeTaskId}`
        : 'Worker paused';
    }
    if (this.workerStatus.quotaWaitingUntil !== null && this.workerStatus.quotaWaitingUntil !== undefined) {
      return 'Waiting for Codex quota';
    }
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

  workerPaused(): boolean {
    return this.workerStatus?.paused ?? false;
  }

  quotaLoopTitle(): string {
    if (!this.workerStatus?.quotaLoopEnabled) return 'Enable automatic Codex usage refresh and resume after quota reset';
    const until = this.workerStatus.quotaWaitingUntil;
    if (until !== null && until !== undefined) {
      return `Waiting for Codex quota until ${new Date(until).toLocaleString()}`;
    }
    const nextReset = [this.agentUsage?.primary?.resetsAt, this.agentUsage?.secondary?.resetsAt]
      .filter((value): value is number => value !== null && value !== undefined && value * 1_000 > Date.now())
      .sort((left, right) => left - right)[0];
    return nextReset === undefined
      ? 'Usage auto-resume is on; checking Codex quota before each task'
      : `Usage auto-resume is on; next quota refresh ${new Date(nextReset * 1_000).toLocaleString()}`;
  }
}
