import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { BranchLane, ProjectBranchMap } from '../../models';
import { CytoscapeBranchGraphComponent } from '../cytoscape-branch-graph/cytoscape-branch-graph.component';

@Component({
  selector: 'feature-map',
  standalone: true,
  imports: [CommonModule, CytoscapeBranchGraphComponent],
  templateUrl: './feature-map.component.html',
})
export class FeatureMapComponent {
  private readonly branchColors = ['#3977d4', '#9b59b6', '#df7b24', '#199b83', '#d34f74', '#6876d8', '#4f8f31', '#b65f42'];
  private readonly laneCache = new WeakMap<ProjectBranchMap, BranchLane[]>();

  @Input({ required: true }) maps: readonly ProjectBranchMap[] = [];
  @Input({ required: true }) loading = false;
  @Output() createFeature = new EventEmitter<number>();
  @Output() taskOpened = new EventEmitter<number>();
  @Output() branchOrderChanged = new EventEmitter<{ projectId: number; branchNames: string[] }>();

  branchColor(index: number): string {
    return this.branchColors[index % this.branchColors.length]!;
  }

  trackProject(_index: number, map: ProjectBranchMap): number {
    return map.project.id;
  }

  featureLanes(map: ProjectBranchMap): BranchLane[] {
    const cached = this.laneCache.get(map);
    if (cached !== undefined) return cached;
    const lanes = map.branches.filter((lane) => !lane.is_primary);
    const hasManualOrder = lanes.some((lane) => lane.display_order !== null && lane.display_order !== undefined);
    lanes.sort((left, right) => hasManualOrder
      ? this.manualBranchComparison(left, right)
      : this.defaultBranchComparison(left, right));
    this.laneCache.set(map, lanes);
    return lanes;
  }

  moveBranch(map: ProjectBranchMap, lane: BranchLane, offset: -1 | 1): void {
    const lanes = this.featureLanes(map);
    const currentIndex = lanes.findIndex((item) => item.name === lane.name);
    const destination = currentIndex + offset;
    if (currentIndex < 0 || destination < 0 || destination >= lanes.length) return;
    const reordered = [...lanes];
    [reordered[currentIndex], reordered[destination]] = [reordered[destination]!, reordered[currentIndex]!];
    this.branchOrderChanged.emit({ projectId: map.project.id, branchNames: reordered.map((item) => item.name) });
  }

  canMoveBranch(map: ProjectBranchMap, lane: BranchLane, offset: -1 | 1): boolean {
    const lanes = this.featureLanes(map);
    const index = lanes.findIndex((item) => item.name === lane.name);
    return index >= 0 && index + offset >= 0 && index + offset < lanes.length;
  }


  private branchTimestamp(lane: BranchLane): number {
    const value = lane.feature?.created_at ?? lane.fork_commit?.committed_at;
    if (value === undefined) return 0;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  private defaultBranchComparison(left: BranchLane, right: BranchLane): number {
    return this.branchTimestamp(right) - this.branchTimestamp(left) || right.name.localeCompare(left.name);
  }

  private manualBranchComparison(left: BranchLane, right: BranchLane): number {
    const leftOrder = left.display_order;
    const rightOrder = right.display_order;
    if (leftOrder === null || leftOrder === undefined) {
      return rightOrder === null || rightOrder === undefined ? this.defaultBranchComparison(left, right) : -1;
    }
    if (rightOrder === null || rightOrder === undefined) return 1;
    return leftOrder - rightOrder || this.defaultBranchComparison(left, right);
  }
}
