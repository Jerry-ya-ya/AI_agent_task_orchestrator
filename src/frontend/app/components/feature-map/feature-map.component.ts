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
  private readonly branchColors = ['#3977d4', '#9b59b6', '#df7b24', '#199b83', '#d34f74', '#6876d8', '#4f8f31', '#b65f42'];

  @Input({ required: true }) maps: readonly ProjectBranchMap[] = [];
  @Input({ required: true }) loading = false;
  @Output() createFeature = new EventEmitter<number>();
  @Output() taskOpened = new EventEmitter<number>();
  @Output() branchOrderChanged = new EventEmitter<{ projectId: number; branchNames: string[] }>();

  isCheckpoint(lane: BranchLane, task: BranchTaskHistory): boolean {
    const nextIndex = lane.tasks.findIndex((item) => item.status === 'TODO');
    return nextIndex > 0 && lane.tasks[nextIndex - 1]?.id === task.id;
  }

  highlightStart(lane: BranchLane): boolean {
    return lane.tasks[0]?.status === 'TODO';
  }

  branchColor(index: number): string {
    return this.branchColors[index % this.branchColors.length]!;
  }

  orderedPrimaryCommits(map: ProjectBranchMap): ProjectBranchMap['primary_commits'] {
    return [...map.primary_commits].reverse();
  }

  featureLanes(map: ProjectBranchMap): BranchLane[] {
    const lanes = map.branches.filter((lane) => !lane.is_primary);
    const hasManualOrder = lanes.some((lane) => lane.display_order !== null && lane.display_order !== undefined);
    return lanes.sort((left, right) => hasManualOrder
      ? this.manualBranchComparison(left, right)
      : this.defaultBranchComparison(left, right));
  }

  moveBranch(map: ProjectBranchMap, lane: BranchLane, offset: -1 | 1): void {
    const lanes = this.featureLanes(map);
    const currentIndex = lanes.findIndex((item) => item.name === lane.name);
    const destination = currentIndex + offset;
    if (currentIndex < 0 || destination < 0 || destination >= lanes.length) return;
    [lanes[currentIndex], lanes[destination]] = [lanes[destination]!, lanes[currentIndex]!];
    this.branchOrderChanged.emit({ projectId: map.project.id, branchNames: lanes.map((item) => item.name) });
  }

  canMoveBranch(map: ProjectBranchMap, lane: BranchLane, offset: -1 | 1): boolean {
    const lanes = this.featureLanes(map);
    const index = lanes.findIndex((item) => item.name === lane.name);
    return index >= 0 && index + offset >= 0 && index + offset < lanes.length;
  }

  networkWidth(map: ProjectBranchMap): number {
    const mainWidth = 56 + (map.primary_commits.length * 132) + (Math.max(0, map.primary_commits.length - 1) * 24);
    const widestFeature = this.featureLanes(map).reduce((widest, lane) => {
      const laneWidth = 56 + this.forkOffset(map, lane) + 132 + (lane.tasks.length * 142) + (lane.tasks.length * 24);
      return Math.max(widest, laneWidth);
    }, 0);
    return 220 + Math.max(720, mainWidth, widestFeature);
  }

  forkOffset(map: ProjectBranchMap, lane: BranchLane): number {
    if (lane.fork_commit === null) return 0;
    const index = this.orderedPrimaryCommits(map).findIndex((commit) => commit.sha === lane.fork_commit?.sha);
    return Math.max(0, index) * 156;
  }

  connectorTop(laneIndex: number): number {
    return 47 - ((laneIndex + 1) * 126);
  }

  connectorHeight(laneIndex: number): number {
    return 2 + ((laneIndex + 1) * 126);
  }

  forkLabel(lane: BranchLane, map: ProjectBranchMap): string {
    if (lane.fork_commit !== null) return `${lane.fork_commit.short_sha} · ${lane.fork_commit.summary}`;
    return lane.feature?.base_branch ?? map.primary_branch ?? 'main';
  }

  commitFeatureColors(map: ProjectBranchMap, summary: string): string[] {
    const commitSummary = this.firstLine(summary);
    return this.featureLanes(map).flatMap((lane, index) => {
      if (lane.feature === null) return [];
      const matches = lane.tasks.some((task) => task.commit_summary !== null
        && this.firstLine(task.commit_summary) === commitSummary);
      return matches ? [this.branchColor(index)] : [];
    });
  }

  forkFeatureColors(map: ProjectBranchMap, sha: string): string[] {
    return this.featureLanes(map).flatMap((lane, index) => lane.fork_commit?.sha === sha
      ? [this.branchColor(index)]
      : []);
  }

  mainCommitFill(map: ProjectBranchMap, summary: string): string | null {
    const colors = this.commitFeatureColors(map, summary);
    if (colors.length === 0) return null;
    if (colors.length === 1) return colors[0]!;
    const slice = 100 / colors.length;
    return `conic-gradient(${colors.map((color, index) => `${color} ${index * slice}% ${(index + 1) * slice}%`).join(', ')})`;
  }

  statusLabel(status: TaskStatus): string {
    return status.replaceAll('_', ' ').toLowerCase();
  }

  private firstLine(value: string): string {
    return value.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim().toLocaleLowerCase() ?? '';
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
