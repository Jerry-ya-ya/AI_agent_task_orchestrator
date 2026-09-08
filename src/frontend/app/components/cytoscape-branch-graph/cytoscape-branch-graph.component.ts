import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import type cytoscape from 'cytoscape';

import type { BranchCommit, BranchLane, ProjectBranchMap, TaskStatus } from '../../models';

const BRANCH_COLORS = ['#3977d4', '#9b59b6', '#df7b24', '#199b83', '#d34f74', '#6876d8', '#4f8f31', '#b65f42'];
const MAIN_Y = 72;
const FIRST_NODE_X = 250;
const COMMIT_GAP = 190;
const FIRST_BRANCH_Y = 220;
const BRANCH_GAP = 152;

interface BranchGraphModel {
  elements: cytoscape.ElementDefinition[];
  height: number;
}

@Component({
  selector: 'cytoscape-branch-graph',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './cytoscape-branch-graph.component.html',
  styleUrl: './cytoscape-branch-graph.component.css',
})
export class CytoscapeBranchGraphComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) map!: ProjectBranchMap;
  @Input({ required: true }) lanes: readonly BranchLane[] = [];
  @Output() taskOpened = new EventEmitter<number>();
  @ViewChild('graphHost', { static: true }) private graphHost!: ElementRef<HTMLDivElement>;

  graphHeight = 360;
  private graph: cytoscape.Core | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private viewReady = false;
  private renderVersion = 0;

  ngAfterViewInit(): void {
    this.viewReady = true;
    void this.renderGraph();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.graph?.resize());
      this.resizeObserver.observe(this.graphHost.nativeElement);
    }
  }

  ngOnChanges(_changes: SimpleChanges): void {
    if (this.viewReady) void this.renderGraph();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.renderVersion += 1;
    this.graph?.destroy();
  }

  graphModel(): BranchGraphModel {
    const elements: cytoscape.ElementDefinition[] = [];
    const primaryCommits = [...this.map.primary_commits].reverse();
    const primaryNodeIds = primaryCommits.length === 0
      ? [this.primaryNodeId('start')]
      : primaryCommits.map((commit) => this.primaryNodeId(commit.sha));

    if (primaryCommits.length === 0) {
      elements.push(this.node(primaryNodeIds[0]!, FIRST_NODE_X, MAIN_Y, {
        label: this.map.primary_branch ?? 'main',
        subtitle: 'No commit history available',
      }, 'primary primary-empty'));
    } else {
      primaryCommits.forEach((commit, index) => {
        const colors = this.commitFeatureColors(commit.summary);
        elements.push(this.node(primaryNodeIds[index]!, FIRST_NODE_X + (index * COMMIT_GAP), MAIN_Y, {
          label: commit.summary,
          subtitle: commit.short_sha,
          color: colors[0] ?? '#46515e',
        }, `primary${colors.length > 0 ? ' feature-owned' : ''}`));
        if (index > 0) {
          elements.push(this.edge(
            `primary-edge:${index}`,
            primaryNodeIds[index - 1]!,
            primaryNodeIds[index]!,
            '#46515e',
            'primary-edge',
          ));
        }
      });
    }

    this.lanes.forEach((lane, laneIndex) => {
      const color = BRANCH_COLORS[laneIndex % BRANCH_COLORS.length]!;
      const y = FIRST_BRANCH_Y + (laneIndex * BRANCH_GAP);
      const missingClass = lane.exists ? '' : ' missing';
      const currentClass = lane.is_current ? ' current' : '';
      const forkIndex = this.forkIndex(primaryCommits, lane.fork_commit);
      const forkX = FIRST_NODE_X + (forkIndex * COMMIT_GAP);
      const sourceId = primaryNodeIds[Math.min(forkIndex, primaryNodeIds.length - 1)]!;
      const labelId = `branch:${laneIndex}:label`;
      const forkId = `branch:${laneIndex}:fork`;

      elements.push(this.node(labelId, 86, y, {
        label: lane.feature?.name ?? lane.name,
        subtitle: `${lane.name}\n${lane.exists ? (lane.is_current ? 'current' : 'local') : 'not created'}`,
        color,
      }, `branch-label${missingClass}${currentClass}`));
      elements.push(this.node(forkId, forkX, y, {
        label: 'fork',
        subtitle: this.forkLabel(lane),
        color,
      }, `fork${missingClass}${this.highlightStart(lane) ? ' checkpoint' : ''}`));
      elements.push(this.edge(`fork-edge:${laneIndex}`, sourceId, forkId, color, `fork-edge${missingClass}`));
      elements.push(this.edge(`label-edge:${laneIndex}`, labelId, forkId, color, `branch-edge${missingClass}`));

      let previousId = forkId;
      lane.tasks.forEach((task, taskIndex) => {
        const taskId = `branch:${laneIndex}:task:${task.id}`;
        const checkpointClass = this.isCheckpoint(lane, task.id) ? ' checkpoint' : '';
        elements.push(this.node(taskId, forkX + ((taskIndex + 1) * COMMIT_GAP), y, {
          label: `#${task.id} ${task.title}`,
          subtitle: this.statusLabel(task.status),
          taskId: task.id,
          color,
        }, `task status-${task.status.toLowerCase()}${missingClass}${checkpointClass}`));
        elements.push(this.edge(
          `task-edge:${laneIndex}:${task.id}`,
          previousId,
          taskId,
          color,
          `branch-edge${missingClass}`,
        ));
        previousId = taskId;
      });
    });

    return {
      elements,
      height: Math.max(360, FIRST_BRANCH_Y + (Math.max(1, this.lanes.length) * BRANCH_GAP) - 40),
    };
  }

  private async renderGraph(): Promise<void> {
    const version = ++this.renderVersion;
    const { default: createCytoscape } = await import('cytoscape');
    if (!this.viewReady || version !== this.renderVersion) return;
    this.graph?.destroy();
    const model = this.graphModel();
    this.graphHeight = model.height;
    this.graph = createCytoscape({
      container: this.graphHost.nativeElement,
      elements: model.elements,
      layout: { name: 'preset', fit: false },
      style: this.graphStyles(),
      zoom: 0.88,
      pan: { x: 24, y: 30 },
      minZoom: 0.35,
      maxZoom: 2,
      wheelSensitivity: 0.16,
      boxSelectionEnabled: false,
      selectionType: 'single',
    });
    this.graph.on('tap', 'node.task', (event) => {
      const taskId = Number(event.target.data('taskId'));
      if (Number.isInteger(taskId)) this.taskOpened.emit(taskId);
    });
  }

  private graphStyles(): cytoscape.StylesheetJson {
    return [
      { selector: 'node', style: {
        'background-color': '#ffffff', 'border-color': 'data(color)', 'border-width': 3,
        color: '#333c46', label: 'data(label)', 'font-family': 'Inter, system-ui, sans-serif',
        'font-size': 10, 'font-weight': 650, 'text-valign': 'top', 'text-margin-y': -14,
        'text-wrap': 'ellipsis', 'text-max-width': '150px', width: 18, height: 18,
      } },
      { selector: 'node.primary', style: { 'border-color': '#46515e', 'background-color': 'data(color)' } },
      { selector: 'node.primary-empty', style: { width: 20, height: 20, 'text-max-width': '190px' } },
      { selector: 'node.feature-owned', style: { 'border-color': '#ffffff', 'border-width': 4 } },
      { selector: 'node.branch-label', style: {
        shape: 'round-rectangle', width: 142, height: 52, 'background-color': '#f8fafc',
        'border-width': 2, 'text-valign': 'center', 'text-margin-y': 0, 'text-max-width': '126px',
      } },
      { selector: 'node.current', style: { 'border-width': 5 } },
      { selector: 'node.fork', style: { width: 16, height: 16, 'font-size': 8, 'text-max-width': '135px' } },
      { selector: 'node.task', style: { width: 19, height: 19 } },
      { selector: 'node.status-done', style: { 'border-color': '#29966a', 'background-color': '#dff4e9' } },
      { selector: 'node.status-failed', style: { 'border-color': '#c84545', 'background-color': '#fae2e2' } },
      { selector: 'node.status-rejected', style: { 'border-color': '#8c6b6b', 'background-color': '#eee5e5' } },
      { selector: 'node.status-todo', style: { 'border-color': '#9ba5b0' } },
      { selector: 'node.checkpoint', style: { 'border-color': '#f0a52e', 'border-width': 5 } },
      { selector: 'node.missing', style: {
        'background-color': '#f2f3f4', 'border-color': '#9ba1a8', color: '#777f87', opacity: 0.52,
      } },
      { selector: 'edge', style: {
        width: 3, 'line-color': 'data(color)', 'curve-style': 'straight', opacity: 0.92,
      } },
      { selector: 'edge.fork-edge', style: {
        'curve-style': 'taxi', 'taxi-direction': 'downward', 'taxi-turn': '50%',
      } },
      { selector: 'edge.missing', style: { 'line-color': '#9ba1a8', opacity: 0.38 } },
      { selector: 'node:selected', style: { 'overlay-color': '#3977d4', 'overlay-opacity': 0.12, 'overlay-padding': 8 } },
    ];
  }

  private node(
    id: string,
    x: number,
    y: number,
    data: Record<string, string | number>,
    classes: string,
  ): cytoscape.NodeDefinition {
    return { data: { id, ...data }, position: { x, y }, classes, grabbable: false };
  }

  private edge(id: string, source: string, target: string, color: string, classes: string): cytoscape.EdgeDefinition {
    return { data: { id, source, target, color }, classes };
  }

  private primaryNodeId(sha: string): string {
    return `primary:${sha}`;
  }

  private forkIndex(commits: readonly BranchCommit[], fork: BranchCommit | null): number {
    if (fork === null) return 0;
    const index = commits.findIndex((commit) => commit.sha === fork.sha);
    return Math.max(0, index);
  }

  private forkLabel(lane: BranchLane): string {
    if (lane.fork_commit !== null) return `${lane.fork_commit.short_sha} · ${lane.fork_commit.summary}`;
    return lane.feature?.base_branch ?? this.map.primary_branch ?? 'main';
  }

  private commitFeatureColors(summary: string): string[] {
    const commitSummary = this.firstLine(summary);
    return this.lanes.flatMap((lane, index) => lane.tasks.some((task) => task.commit_summary !== null
      && this.firstLine(task.commit_summary) === commitSummary)
      ? [BRANCH_COLORS[index % BRANCH_COLORS.length]!]
      : []);
  }

  private isCheckpoint(lane: BranchLane, taskId: number): boolean {
    const nextIndex = lane.tasks.findIndex((task) => task.status === 'TODO');
    return nextIndex > 0 && lane.tasks[nextIndex - 1]?.id === taskId;
  }

  private highlightStart(lane: BranchLane): boolean {
    return lane.tasks[0]?.status === 'TODO';
  }

  private statusLabel(status: TaskStatus): string {
    return status.replaceAll('_', ' ').toLowerCase();
  }

  private firstLine(value: string): string {
    return value.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim().toLocaleLowerCase() ?? '';
  }
}
