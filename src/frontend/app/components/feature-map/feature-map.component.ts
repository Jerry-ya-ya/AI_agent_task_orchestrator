import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { BranchLane, BranchTaskHistory, ProjectBranchMap, TaskStatus } from '../../models';

@Component({
  selector: 'feature-map',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './feature-map.component.html',
})
export class FeatureMapComponent {
  @Input({ required: true }) maps: readonly ProjectBranchMap[] = [];
  @Input({ required: true }) loading = false;
  @Output() createFeature = new EventEmitter<void>();
  @Output() taskOpened = new EventEmitter<number>();

  isCheckpoint(lane: BranchLane, task: BranchTaskHistory): boolean {
    const nextIndex = lane.tasks.findIndex((item) => item.status === 'TODO');
    return nextIndex > 0 && lane.tasks[nextIndex - 1]?.id === task.id;
  }

  highlightStart(lane: BranchLane): boolean {
    return lane.tasks[0]?.status === 'TODO';
  }

  statusLabel(status: TaskStatus): string {
    return status.replaceAll('_', ' ').toLowerCase();
  }
}
