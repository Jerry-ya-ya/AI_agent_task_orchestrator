import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { BranchLane, ProjectBranchMap } from '../../models';
import { CytoscapeBranchGraphComponent } from '../cytoscape-branch-graph/cytoscape-branch-graph.component';

const SELECTED_PROJECT_STORAGE_KEY = 'agentboard.featureMap.selectedProjectId';

@Component({
  selector: 'feature-map',
  standalone: true,
  imports: [CommonModule, CytoscapeBranchGraphComponent],
  templateUrl: './feature-map.component.html',
})
export class FeatureMapComponent {
  private readonly branchColors = ['#3977d4', '#9b59b6', '#df7b24', '#199b83', '#d34f74', '#6876d8', '#4f8f31', '#b65f42'];
  private readonly laneCache = new WeakMap<ProjectBranchMap, BranchLane[]>();
  private projectMaps: readonly ProjectBranchMap[] = [];
  private selectionRestored = false;
  selectedProjectId: number | null = null;

  @Input({ required: true })
  set maps(value: readonly ProjectBranchMap[]) {
    this.projectMaps = value;
    if (!this.selectionRestored) {
      this.selectedProjectId = this.readSelectedProjectId();
      this.selectionRestored = true;
    }
    if (value.length > 0 && !value.some((map) => map.project.id === this.selectedProjectId)) {
      this.setSelectedProjectId(value[0]!.project.id);
    }
  }
  get maps(): readonly ProjectBranchMap[] { return this.projectMaps; }
  @Input({ required: true }) loading = false;
  @Output() createFeature = new EventEmitter<number>();
  @Output() taskOpened = new EventEmitter<number>();
  @Output() createTask = new EventEmitter<number>();
  @Output() resetBranch = new EventEmitter<number>();
  @Output() resetAllBranches = new EventEmitter<number>();
  @Output() deleteGitBranch = new EventEmitter<number>();
  @Output() deleteDatabaseBranch = new EventEmitter<number>();
  @Output() deleteLegacyGitBranch = new EventEmitter<{ projectId: number; branchName: string }>();
  @Output() branchOrderChanged = new EventEmitter<{ projectId: number; branchNames: string[] }>();

  branchColor(index: number): string {
    return this.branchColors[index % this.branchColors.length]!;
  }

  trackProject(_index: number, map: ProjectBranchMap): number {
    return map.project.id;
  }

  selectedMap(): ProjectBranchMap | null {
    return this.maps.find((map) => map.project.id === this.selectedProjectId) ?? null;
  }

  selectProject(value: string): void {
    const projectId = Number(value);
    if (Number.isInteger(projectId) && this.maps.some((map) => map.project.id === projectId)) {
      this.setSelectedProjectId(projectId);
    }
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

  private readSelectedProjectId(): number | null {
    try {
      const projectId = Number(globalThis.localStorage?.getItem(SELECTED_PROJECT_STORAGE_KEY));
      return Number.isInteger(projectId) && projectId > 0 ? projectId : null;
    } catch {
      return null;
    }
  }

  private setSelectedProjectId(projectId: number): void {
    this.selectedProjectId = projectId;
    try {
      globalThis.localStorage?.setItem(SELECTED_PROJECT_STORAGE_KEY, String(projectId));
    } catch {
      // The board remains usable when storage is disabled or unavailable.
    }
  }
}
