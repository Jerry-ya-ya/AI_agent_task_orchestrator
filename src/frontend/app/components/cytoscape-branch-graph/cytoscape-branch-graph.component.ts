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
const STICKY_BRANCH_LABEL_X = 86;
const BRANCH_ACTION_GAP = 122;
const BRANCH_ACTION_FAN_Y = 56;
const BRANCH_DELETE_ACTION_GAP = 116;
const BRANCH_DELETE_ACTION_FAN_Y = 24;
const INITIAL_ZOOM = 0.88;
const INITIAL_PAN: cytoscape.Position = { x: 24, y: 30 };
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;
const ZOOM_SENSITIVITIES = [1, 2, 3] as const;
const ZOOM_SENSITIVITY_STORAGE_PREFIX = 'agentboard.featureMap.zoomSensitivity.';
const POINTER_RESET_BLOCKING_STATUSES: ReadonlySet<TaskStatus> = new Set(['IN_REVIEW', 'REVIEWING', 'PENDING_PUSH']);

interface BranchGraphModel {
  elements: cytoscape.ElementDefinition[];
}

interface GraphViewport {
  zoom: number;
  pan: cytoscape.Position;
}

@Component({
  selector: 'cytoscape-branch-graph',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './cytoscape-branch-graph.component.html',
  styleUrl: './cytoscape-branch-graph.component.css',
})
export class CytoscapeBranchGraphComponent implements AfterViewInit, OnChanges, OnDestroy {
  private static readonly viewportByProject = new Map<number, GraphViewport>();

  private projectMap: ProjectBranchMap | null = null;

  @Input({ required: true })
  set map(value: ProjectBranchMap) {
    if (this.projectMap?.project.id !== value.project.id) {
      this.expandedFeatureId = null;
      this.expandedDeleteFeatureId = null;
      this.expandedLegacyBranchName = null;
      this.expandedLegacyDeleteBranchName = null;
    }
    this.projectMap = value;
    this.zoomSensitivity = this.readZoomSensitivity(value.project.id);
  }
  get map(): ProjectBranchMap {
    return this.projectMap!;
  }
  @Input({ required: true }) lanes: readonly BranchLane[] = [];
  @Output() taskOpened = new EventEmitter<number>();
  @Output() featureCreationRequested = new EventEmitter<number>();
  @Output() taskCreationRequested = new EventEmitter<number>();
  @Output() branchResetRequested = new EventEmitter<number>();
  @Output() gitBranchDeleteRequested = new EventEmitter<number>();
  @Output() databaseBranchDeleteRequested = new EventEmitter<number>();
  @Output() legacyGitBranchDeleteRequested = new EventEmitter<{ projectId: number; branchName: string }>();
  @Output() allBranchesResetRequested = new EventEmitter<number>();
  @ViewChild('graphHost', { static: true }) private graphHost!: ElementRef<HTMLDivElement>;

  graphReady = false;
  zoomSensitivity = 1;
  private graph: cytoscape.Core | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private viewReady = false;
  private renderVersion = 0;
  private requestedSignature: string | null = null;
  private renderedProjectId: number | null = null;
  private expandedFeatureId: number | null = null;
  private expandedDeleteFeatureId: number | null = null;
  private expandedLegacyBranchName: string | null = null;
  private expandedLegacyDeleteBranchName: string | null = null;

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.requestRender();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resizeGraphPreservingViewport());
      this.resizeObserver.observe(this.graphHost.nativeElement);
    }
  }

  ngOnChanges(_changes: SimpleChanges): void {
    if (this.viewReady) this.requestRender();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.renderVersion += 1;
    this.saveViewport();
    this.graph?.destroy();
    this.graph = null;
    this.graphReady = false;
  }

  resetView(): void {
    if (this.graph === null) return;
    const viewport = this.initialViewport();
    CytoscapeBranchGraphComponent.viewportByProject.set(this.map.project.id, viewport);
    this.graph.stop();
    this.graph.zoom(viewport.zoom);
    this.graph.pan(viewport.pan);
  }

  hasResettableBranches(): boolean {
    return this.lanes.some((lane) => lane.exists && lane.feature !== null);
  }

  hasProtectedPointerTasks(): boolean {
    return this.lanes.some((lane) => this.laneHasProtectedPointerTasks(lane));
  }

  setZoomSensitivity(value: string): void {
    const sensitivity = Number(value);
    if (!ZOOM_SENSITIVITIES.some((option) => option === sensitivity)) return;
    this.zoomSensitivity = sensitivity;
    if (this.projectMap !== null) {
      try {
        globalThis.localStorage?.setItem(
          `${ZOOM_SENSITIVITY_STORAGE_PREFIX}${this.projectMap.project.id}`,
          String(sensitivity),
        );
      } catch {
        // Keep the graph controls functional when storage is unavailable.
      }
    }
    if (this.viewReady) this.requestRender();
  }

  graphModel(): BranchGraphModel {
    const elements: cytoscape.ElementDefinition[] = [];
    const primaryCommits = this.map.primary_commits;
    const longestBranchHistory = this.lanes.reduce(
      (longest, lane) => Math.max(longest, this.pointerResetBoundaryIndex(lane)),
      0,
    );
    const primaryStartX = FIRST_NODE_X + (longestBranchHistory * COMMIT_GAP);
    const primaryNodeIds = primaryCommits.length === 0
      ? [this.primaryNodeId('start')]
      : primaryCommits.map((commit) => this.primaryNodeId(commit.sha));
    const primaryLabelId = 'primary:label';

    elements.push(this.node(primaryLabelId, STICKY_BRANCH_LABEL_X, MAIN_Y, {
      label: this.map.primary_branch ?? 'main',
      subtitle: 'Primary branch',
      color: '#46515e',
    }, 'primary-label'));

    if (primaryCommits.length === 0) {
      elements.push(this.node(primaryNodeIds[0]!, primaryStartX, MAIN_Y, {
        label: this.map.primary_branch ?? 'main',
        subtitle: 'No commit history available',
      }, 'primary primary-empty'));
    } else {
      primaryCommits.forEach((commit, index) => {
        const colors = this.commitFeatureColors(commit.summary);
        elements.push(this.node(primaryNodeIds[index]!, primaryStartX + (index * COMMIT_GAP), MAIN_Y, {
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
    elements.push(this.edge(
      'primary-label-edge', primaryLabelId, primaryNodeIds[0]!, '#46515e', 'primary-edge primary-label-edge',
    ));

    this.lanes.forEach((lane, laneIndex) => {
      const color = BRANCH_COLORS[laneIndex % BRANCH_COLORS.length]!;
      const y = FIRST_BRANCH_Y + (laneIndex * BRANCH_GAP);
      const missingClass = lane.exists ? '' : ' missing';
      const currentClass = lane.is_current ? ' current' : '';
      const forkIndex = this.forkIndex(primaryCommits, lane.fork_commit);
      const forkX = primaryStartX + (forkIndex * COMMIT_GAP);
      const sourceId = primaryNodeIds[Math.min(forkIndex, primaryNodeIds.length - 1)]!;
      const labelId = `branch:${laneIndex}:label`;
      const pointerId = `branch:${laneIndex}:pointer`;
      const pointerX = forkX;
      const resetPointerId = `branch:${laneIndex}:reset-pointer`;
      const pointerResetTaskId = lane.feature?.pointer_reset_task_id;
      const hasPointerResetMarker = pointerResetTaskId !== null && pointerResetTaskId !== undefined;
      const resetBoundaryIndex = this.pointerResetBoundaryIndex(lane);
      const postResetTaskCount = hasPointerResetMarker ? lane.tasks.length - resetBoundaryIndex : 0;
      const headX = hasPointerResetMarker
        ? pointerX + ((postResetTaskCount + 1) * COMMIT_GAP)
        : pointerX;
      const managedLegacyBranch = lane.feature === null && lane.exists && this.isManagedBranch(lane.name);
      const hasBranchActions = lane.feature !== null || managedLegacyBranch;

      elements.push(this.node(labelId, 86, y, {
        label: lane.feature?.name ?? lane.name,
        subtitle: `${lane.name}\n${lane.exists ? (lane.is_current ? 'current' : 'local') : 'not created'}`,
        color,
      }, `branch-label${missingClass}${currentClass}`));
      elements.push(this.node(pointerId, headX, y, {
        label: hasBranchActions ? 'HEAD +' : 'HEAD',
        subtitle: hasPointerResetMarker ? 'current branch end' : this.forkLabel(lane),
        ...(lane.feature === null ? {} : { featureId: lane.feature.id }),
        ...(managedLegacyBranch ? { legacyBranchName: lane.name, projectId: this.map.project.id } : {}),
        color,
      }, `branch-pointer${hasBranchActions ? ' branch-actions' : ''}${missingClass}`));
      elements.push(this.edge(
        `fork-edge:${laneIndex}`,
        sourceId,
        hasPointerResetMarker ? resetPointerId : pointerId,
        color,
        `fork-edge${missingClass}`,
      ));

      let previousId: string | null = null;
      let firstHistoryId: string | null = null;
      lane.tasks.forEach((task, taskIndex) => {
        if (hasPointerResetMarker && taskIndex === resetBoundaryIndex) {
          elements.push(this.node(resetPointerId, pointerX, y, {
            label: 'POINTER',
            subtitle: `reset to ${this.forkLabel(lane)}`,
            color,
          }, `branch-pointer reset-pointer${missingClass}`));
          if (previousId !== null) {
            elements.push(this.edge(
              `reset-pointer-edge:${laneIndex}`,
              previousId,
              resetPointerId,
              color,
              `branch-edge reset-boundary-edge${missingClass}`,
            ));
          }
          firstHistoryId ??= resetPointerId;
          previousId = resetPointerId;
        }
        const taskId = `branch:${laneIndex}:task:${task.id}`;
        const taskX = hasPointerResetMarker
          ? taskIndex < resetBoundaryIndex
            ? pointerX - ((resetBoundaryIndex - taskIndex) * COMMIT_GAP)
            : pointerX + ((taskIndex - resetBoundaryIndex + 1) * COMMIT_GAP)
          : pointerX - ((lane.tasks.length - taskIndex) * COMMIT_GAP);
        const checkpointClass = this.isCheckpoint(lane.tasks, task.id) ? ' checkpoint' : '';
        const historicalClass = task.is_before_pointer_reset ? ' historical' : '';
        elements.push(this.node(taskId, taskX, y, {
          label: `#${task.id} ${task.title}`,
          subtitle: task.is_before_pointer_reset
            ? `${this.statusLabel(task.status)} · before pointer reset`
            : this.statusLabel(task.status),
          taskId: task.id,
          color,
        }, `task status-${task.status.toLowerCase()}${historicalClass}${missingClass}${checkpointClass}`));
        if (previousId !== null) {
          elements.push(this.edge(
            `task-edge:${laneIndex}:${task.id}`,
            previousId,
            taskId,
            color,
            `branch-edge${missingClass}`,
          ));
        }
        firstHistoryId ??= taskId;
        previousId = taskId;
      });
      if (hasPointerResetMarker && resetBoundaryIndex === lane.tasks.length) {
        elements.push(this.node(resetPointerId, pointerX, y, {
          label: 'POINTER',
          subtitle: `reset to ${this.forkLabel(lane)}`,
          color,
        }, `branch-pointer reset-pointer${missingClass}`));
        if (previousId !== null) {
          elements.push(this.edge(
            `reset-pointer-edge:${laneIndex}`,
            previousId,
            resetPointerId,
            color,
            `branch-edge reset-boundary-edge${missingClass}`,
          ));
        }
        firstHistoryId ??= resetPointerId;
        previousId = resetPointerId;
      }
      elements.push(this.edge(
        `label-edge:${laneIndex}`,
        labelId,
        firstHistoryId ?? (hasPointerResetMarker ? resetPointerId : pointerId),
        color,
        `branch-edge${missingClass}`,
      ));
      if (previousId !== null) {
        elements.push(this.edge(
          `pointer-edge:${laneIndex}`,
          previousId,
          pointerId,
          color,
          `branch-edge${missingClass}`,
        ));
      }

      if (lane.feature !== null) {
        const featureId = lane.feature.id;
        const collapsedClass = this.expandedFeatureId === featureId ? '' : ' branch-action-collapsed';
        const deleteCollapsedClass = this.expandedDeleteFeatureId === featureId
          ? ''
          : ' branch-action-collapsed';

        const addTaskId = `branch:${laneIndex}:action:add-task`;
        elements.push(this.node(addTaskId, headX + BRANCH_ACTION_GAP, y - BRANCH_ACTION_FAN_Y, {
          label: '+ Task',
          subtitle: 'Create task',
          featureId,
          color,
        }, `branch-action-option branch-action-add branch-action-menu-item${collapsedClass}${missingClass}`));
        elements.push(this.edge(
          `branch-action-edge:${laneIndex}:add-task`, pointerId, addTaskId, color,
          `branch-action-fan branch-action-menu-item${collapsedClass}${missingClass}`, { featureId },
        ));

        if (lane.exists) {
          const resetBlocked = this.laneHasProtectedPointerTasks(lane);
          const resetBranchId = `branch:${laneIndex}:action:reset-main`;
          elements.push(this.node(resetBranchId, headX + BRANCH_ACTION_GAP, y, {
            label: resetBlocked ? 'Review locked' : '↺ main',
            subtitle: resetBlocked ? 'Finish Review or pending push first' : 'Reset branch pointer',
            featureId,
            resetBlocked: resetBlocked ? 1 : 0,
            color,
          }, `branch-action-option branch-action-reset branch-action-menu-item${resetBlocked ? ' branch-action-disabled' : ''}${collapsedClass}`));
          elements.push(this.edge(
            `branch-action-edge:${laneIndex}:reset-main`, pointerId, resetBranchId, color,
            `branch-action-fan branch-action-menu-item${collapsedClass}`, { featureId },
          ));
        }

        const deleteMenuId = `branch:${laneIndex}:action:delete`;
        const deleteMenuX = headX + BRANCH_ACTION_GAP;
        const deleteMenuY = y + BRANCH_ACTION_FAN_Y;
        elements.push(this.node(deleteMenuId, deleteMenuX, deleteMenuY, {
          label: 'Delete ›',
          subtitle: 'Branch deletion options',
          featureId,
          color,
        }, `branch-action-option branch-action-delete-menu branch-action-menu-item${collapsedClass}${missingClass}`));
        elements.push(this.edge(
          `branch-action-edge:${laneIndex}:delete`, pointerId, deleteMenuId, color,
          `branch-action-fan branch-action-menu-item${collapsedClass}${missingClass}`, { featureId },
        ));

        const deleteGitId = `branch:${laneIndex}:action:delete-git`;
        const gitDeleteDisabled = lane.exists ? 0 : 1;
        elements.push(this.node(
          deleteGitId,
          deleteMenuX + BRANCH_DELETE_ACTION_GAP,
          deleteMenuY - BRANCH_DELETE_ACTION_FAN_Y,
          {
            label: lane.exists ? 'Delete Git' : 'Git missing',
            subtitle: lane.exists ? 'Keep Feature and task history' : 'Local branch already absent',
            featureId,
            deleteDisabled: gitDeleteDisabled,
            color,
          },
          `branch-action-option branch-action-delete-git branch-delete-menu-item${gitDeleteDisabled ? ' branch-action-disabled' : ''}${deleteCollapsedClass}${missingClass}`,
        ));
        elements.push(this.edge(
          `branch-delete-edge:${laneIndex}:git`, deleteMenuId, deleteGitId, color,
          `branch-action-fan branch-delete-menu-item${deleteCollapsedClass}${missingClass}`, { featureId },
        ));

        const deleteDatabaseId = `branch:${laneIndex}:action:delete-database`;
        elements.push(this.node(
          deleteDatabaseId,
          deleteMenuX + BRANCH_DELETE_ACTION_GAP,
          deleteMenuY + BRANCH_DELETE_ACTION_FAN_Y,
          {
            label: 'Delete both',
            subtitle: 'Remove Git and Feature record',
            featureId,
            color,
          },
          `branch-action-option branch-action-delete-database branch-delete-menu-item${deleteCollapsedClass}${missingClass}`,
        ));
        elements.push(this.edge(
          `branch-delete-edge:${laneIndex}:database`, deleteMenuId, deleteDatabaseId, color,
          `branch-action-fan branch-delete-menu-item${deleteCollapsedClass}${missingClass}`, { featureId },
        ));
      } else if (managedLegacyBranch) {
        const collapsedClass = this.expandedLegacyBranchName === lane.name ? '' : ' branch-action-collapsed';
        const deleteCollapsedClass = this.expandedLegacyDeleteBranchName === lane.name
          ? ''
          : ' branch-action-collapsed';
        const commonData = { legacyBranchName: lane.name, projectId: this.map.project.id };
        const deleteMenuId = `branch:${laneIndex}:action:delete-legacy`;
        const deleteMenuX = headX + BRANCH_ACTION_GAP;
        elements.push(this.node(deleteMenuId, deleteMenuX, y, {
          label: 'Delete ›',
          subtitle: 'Legacy branch deletion',
          color,
          ...commonData,
        }, `branch-action-option branch-action-delete-menu branch-legacy-action-menu-item${collapsedClass}`));
        elements.push(this.edge(
          `branch-action-edge:${laneIndex}:delete-legacy`, pointerId, deleteMenuId, color,
          `branch-action-fan branch-legacy-action-menu-item${collapsedClass}`, commonData,
        ));
        const deleteGitId = `branch:${laneIndex}:action:delete-legacy-git`;
        elements.push(this.node(deleteGitId, deleteMenuX + BRANCH_DELETE_ACTION_GAP, y, {
          label: 'Delete Git',
          subtitle: 'Remove legacy local branch',
          color,
          ...commonData,
        }, `branch-action-option branch-action-delete-git branch-legacy-delete-menu-item${deleteCollapsedClass}`));
        elements.push(this.edge(
          `branch-delete-edge:${laneIndex}:legacy-git`, deleteMenuId, deleteGitId, color,
          `branch-action-fan branch-legacy-delete-menu-item${deleteCollapsedClass}`, commonData,
        ));
      }
    });

    const createFeatureY = FIRST_BRANCH_Y + (this.lanes.length * BRANCH_GAP);
    elements.push(this.node('feature:create', STICKY_BRANCH_LABEL_X, createFeatureY, {
      label: '+ New feature',
      subtitle: 'Create a branch from main',
      projectId: this.map.project.id,
      color: '#3977d4',
    }, 'feature-create-action'));

    return {
      elements,
    };
  }

  private requestRender(): void {
    const signature = this.graphSignature();
    if (signature === this.requestedSignature) return;
    this.requestedSignature = signature;
    void this.renderGraph();
  }

  private async renderGraph(): Promise<void> {
    const version = ++this.renderVersion;
    const { default: createCytoscape } = await import('cytoscape');
    if (!this.viewReady || version !== this.renderVersion) return;
    this.saveViewport();
    this.graph?.destroy();
    this.graphReady = false;
    const model = this.graphModel();
    const viewport = this.normalizeViewport(
      CytoscapeBranchGraphComponent.viewportByProject.get(this.map.project.id) ?? this.initialViewport(),
    );
    this.graph = createCytoscape({
      container: this.graphHost.nativeElement,
      elements: model.elements,
      layout: { name: 'preset', fit: false },
      style: this.graphStyles(),
      zoom: viewport.zoom,
      pan: viewport.pan,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      wheelSensitivity: this.zoomSensitivity,
      boxSelectionEnabled: false,
      selectionType: 'single',
    });
    this.renderedProjectId = this.map.project.id;
    this.graph.resize();
    this.applyViewport(viewport);
    this.graphReady = true;
    this.syncBranchLabels();
    this.syncBranchActionVisibility();
    this.graph.on('pan zoom', () => {
      this.saveViewport();
      this.syncBranchLabels();
    });
    this.graph.on('tap', 'node.task', (event) => {
      const taskId = Number(event.target.data('taskId'));
      if (Number.isInteger(taskId)) this.taskOpened.emit(taskId);
    });
    this.graph.on('tap', 'node.feature-create-action', (event) => {
      const projectId = Number(event.target.data('projectId'));
      if (Number.isInteger(projectId)) this.featureCreationRequested.emit(projectId);
    });
    this.graph.on('tap', 'node.branch-actions', (event) => {
      const featureId = Number(event.target.data('featureId'));
      if (Number.isInteger(featureId)) {
        this.toggleBranchActions(featureId);
        return;
      }
      const branchName = String(event.target.data('legacyBranchName') ?? '');
      if (branchName.length > 0) this.toggleLegacyBranchActions(branchName);
    });
    this.graph.on('tap', 'node.branch-action-add', (event) => {
      const featureId = Number(event.target.data('featureId'));
      if (!Number.isInteger(featureId)) return;
      this.toggleBranchActions(featureId, false);
      this.taskCreationRequested.emit(featureId);
    });
    this.graph.on('tap', 'node.branch-action-reset', (event) => {
      const featureId = Number(event.target.data('featureId'));
      if (!Number.isInteger(featureId) || Number(event.target.data('resetBlocked')) === 1) return;
      this.toggleBranchActions(featureId, false);
      this.branchResetRequested.emit(featureId);
    });
    this.graph.on('tap', 'node.branch-action-delete-menu', (event) => {
      const featureId = Number(event.target.data('featureId'));
      if (Number.isInteger(featureId)) {
        this.toggleDeleteActions(featureId);
        return;
      }
      const branchName = String(event.target.data('legacyBranchName') ?? '');
      if (branchName.length > 0) this.toggleLegacyDeleteActions(branchName);
    });
    this.graph.on('tap', 'node.branch-action-delete-git', (event) => {
      const featureId = Number(event.target.data('featureId'));
      if (Number.isInteger(featureId)) {
        if (Number(event.target.data('deleteDisabled')) === 1) return;
        this.toggleBranchActions(featureId, false);
        this.gitBranchDeleteRequested.emit(featureId);
        return;
      }
      const projectId = Number(event.target.data('projectId'));
      const branchName = String(event.target.data('legacyBranchName') ?? '');
      if (!Number.isInteger(projectId) || branchName.length === 0) return;
      this.toggleLegacyBranchActions(branchName, false);
      this.legacyGitBranchDeleteRequested.emit({ projectId, branchName });
    });
    this.graph.on('tap', 'node.branch-action-delete-database', (event) => {
      const featureId = Number(event.target.data('featureId'));
      if (!Number.isInteger(featureId)) return;
      this.toggleBranchActions(featureId, false);
      this.databaseBranchDeleteRequested.emit(featureId);
    });
    this.graph.on('mouseover', 'node.task, node.branch-actions, node.branch-action-option, node.feature-create-action', () => {
      this.graphHost.nativeElement.style.cursor = 'pointer';
    });
    this.graph.on('mouseout', 'node.task, node.branch-actions, node.branch-action-option, node.feature-create-action', () => {
      this.graphHost.nativeElement.style.cursor = 'grab';
    });
  }

  private saveViewport(): void {
    if (this.graph === null || this.renderedProjectId === null) return;
    const pan = this.graph.pan();
    CytoscapeBranchGraphComponent.viewportByProject.set(this.renderedProjectId, this.normalizeViewport({
      zoom: this.graph.zoom(),
      pan: { x: pan.x, y: pan.y },
    }));
  }

  private resizeGraphPreservingViewport(): void {
    if (this.graph === null) return;
    const viewport = this.normalizeViewport({ zoom: this.graph.zoom(), pan: this.graph.pan() });
    this.graph.resize();
    this.applyViewport(viewport);
  }

  private applyViewport(viewport: GraphViewport): void {
    if (this.graph === null) return;
    this.graph.stop();
    this.graph.zoom(viewport.zoom);
    this.graph.pan(viewport.pan);
  }

  private normalizeViewport(viewport: GraphViewport): GraphViewport {
    const zoom = Number.isFinite(viewport.zoom)
      ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom))
      : INITIAL_ZOOM;
    const x = Number.isFinite(viewport.pan.x) ? viewport.pan.x : INITIAL_PAN.x;
    const y = Number.isFinite(viewport.pan.y) ? viewport.pan.y : INITIAL_PAN.y;
    return { zoom, pan: { x, y } };
  }

  private syncBranchLabels(): void {
    if (this.graph === null) return;
    const zoom = this.graph.zoom();
    const pan = this.graph.pan();
    const modelX = (STICKY_BRANCH_LABEL_X - pan.x) / zoom;
    this.graph.nodes('node.branch-label, node.primary-label, node.feature-create-action').forEach((label) => {
      label.position('x', modelX);
    });
  }

  private toggleBranchActions(featureId: number, expanded?: boolean): void {
    const shouldExpand = expanded ?? this.expandedFeatureId !== featureId;
    this.expandedFeatureId = shouldExpand ? featureId : null;
    if (!shouldExpand || this.expandedDeleteFeatureId !== featureId) this.expandedDeleteFeatureId = null;
    this.syncBranchActionVisibility();
  }

  private toggleDeleteActions(featureId: number): void {
    this.expandedDeleteFeatureId = this.expandedDeleteFeatureId === featureId ? null : featureId;
    this.syncBranchActionVisibility();
  }

  private toggleLegacyBranchActions(branchName: string, expanded?: boolean): void {
    const shouldExpand = expanded ?? this.expandedLegacyBranchName !== branchName;
    this.expandedLegacyBranchName = shouldExpand ? branchName : null;
    if (!shouldExpand || this.expandedLegacyDeleteBranchName !== branchName) {
      this.expandedLegacyDeleteBranchName = null;
    }
    this.syncBranchActionVisibility();
  }

  private toggleLegacyDeleteActions(branchName: string): void {
    this.expandedLegacyDeleteBranchName = this.expandedLegacyDeleteBranchName === branchName ? null : branchName;
    this.syncBranchActionVisibility();
  }

  private syncBranchActionVisibility(): void {
    if (this.graph === null) return;
    this.graph.elements('.branch-action-menu-item').forEach((element) => {
      const visible = Number(element.data('featureId')) === this.expandedFeatureId;
      element.toggleClass('branch-action-collapsed', !visible);
    });
    this.graph.elements('.branch-delete-menu-item').forEach((element) => {
      const visible = Number(element.data('featureId')) === this.expandedDeleteFeatureId;
      element.toggleClass('branch-action-collapsed', !visible);
    });
    this.graph.elements('.branch-legacy-action-menu-item').forEach((element) => {
      const visible = String(element.data('legacyBranchName')) === this.expandedLegacyBranchName;
      element.toggleClass('branch-action-collapsed', !visible);
    });
    this.graph.elements('.branch-legacy-delete-menu-item').forEach((element) => {
      const visible = String(element.data('legacyBranchName')) === this.expandedLegacyDeleteBranchName;
      element.toggleClass('branch-action-collapsed', !visible);
    });
  }

  private initialViewport(): GraphViewport {
    return { zoom: INITIAL_ZOOM, pan: { ...INITIAL_PAN } };
  }

  private graphSignature(): string {
    return JSON.stringify({
      projectId: this.map.project.id,
      zoomSensitivity: this.zoomSensitivity,
      currentBranch: this.map.current_branch,
      primaryBranch: this.map.primary_branch,
      primaryCommits: this.map.primary_commits.map((commit) => [
        commit.sha, commit.short_sha, commit.summary, commit.committed_at,
      ]),
      lanes: this.lanes.map((lane) => ({
        name: lane.name,
        exists: lane.exists,
        current: lane.is_current,
        order: lane.display_order,
        fork: lane.fork_commit === null
          ? null
          : [lane.fork_commit.sha, lane.fork_commit.short_sha, lane.fork_commit.summary],
        feature: lane.feature === null
          ? null
          : [lane.feature.id, lane.feature.name, lane.feature.branch_name, lane.feature.base_branch],
        tasks: lane.tasks.map((task) => [
          task.id, task.title, task.status, task.commit_summary, task.is_before_pointer_reset,
          task.created_at, task.updated_at,
        ]),
      })),
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
      { selector: 'node.primary-label', style: {
        shape: 'round-rectangle', width: 142, height: 52, 'background-color': '#46515e',
        'border-color': '#46515e', color: '#ffffff', 'border-width': 2,
        'text-valign': 'center', 'text-margin-y': 0, 'text-max-width': '126px',
      } },
      { selector: 'node.feature-create-action', style: {
        shape: 'round-rectangle', width: 142, height: 42, 'background-color': '#f4f8ff',
        'border-color': '#3977d4', color: '#285faa', 'border-width': 2,
        'font-size': 10, 'font-weight': 700, 'text-valign': 'center', 'text-margin-y': 0,
        'text-max-width': '126px',
      } },
      { selector: 'node.current', style: { 'border-width': 5 } },
      { selector: 'node.task', style: { width: 19, height: 19 } },
      { selector: 'node.branch-pointer', style: {
        shape: 'round-rectangle', width: 56, height: 28, 'background-color': '#ffffff',
        'border-width': 3, 'font-size': 9, 'font-weight': 700, 'text-valign': 'center',
        'text-margin-y': 0, 'text-max-width': '52px',
      } },
      { selector: 'node.branch-actions', style: {
        'border-width': 3,
      } },
      { selector: 'node.reset-pointer', style: {
        width: 66, 'text-max-width': '62px', 'border-style': 'double', 'border-width': 5,
        'background-color': '#f5f8fc', color: '#315f9d',
      } },
      { selector: 'node.branch-action-option', style: {
        shape: 'round-rectangle', width: 88, height: 30, 'background-color': '#ffffff',
        'border-width': 2, 'font-size': 9, 'font-weight': 650, 'text-valign': 'center',
        'text-margin-y': 0, 'text-max-width': '78px',
      } },
      { selector: 'node.branch-action-reset', style: {
        'border-color': '#c46d35', color: '#92502a',
      } },
      { selector: 'node.branch-action-delete-menu, node.branch-action-delete-git', style: {
        'border-color': '#c84545', color: '#a62f35',
      } },
      { selector: 'node.branch-action-delete-database', style: {
        'border-color': '#9f1f27', 'background-color': '#fff3f3', color: '#8f1820',
      } },
      { selector: 'node.branch-action-disabled', style: {
        'border-color': '#aeb5bd', 'background-color': '#f1f3f5', color: '#777f87', opacity: 0.72,
      } },
      { selector: 'node.status-done', style: { 'border-color': '#29966a', 'background-color': '#dff4e9' } },
      { selector: 'node.status-failed', style: { 'border-color': '#c84545', 'background-color': '#fae2e2' } },
      { selector: 'node.status-cherry_pick_conflict', style: { 'border-color': '#d06b28', 'background-color': '#fff0e4' } },
      { selector: 'node.status-reviewing', style: { 'border-color': '#6f48b8', 'background-color': '#ece4fb' } },
      { selector: 'node.status-rejected', style: { 'border-color': '#8c6b6b', 'background-color': '#eee5e5' } },
      { selector: 'node.status-todo', style: { 'border-color': '#9ba5b0' } },
      { selector: 'node.historical', style: { opacity: 0.66, 'background-color': '#eef1f4' } },
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
      { selector: 'edge.branch-action-fan', style: { width: 2, 'curve-style': 'bezier' } },
      { selector: '.branch-action-collapsed', style: { display: 'none' } },
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
    return { data: { id, ...data }, position: { x, y }, classes, grabbable: false, pannable: true };
  }

  private edge(
    id: string,
    source: string,
    target: string,
    color: string,
    classes: string,
    extraData: Record<string, string | number> = {},
  ): cytoscape.EdgeDefinition {
    return { data: { id, source, target, color, ...extraData }, classes };
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

  private isCheckpoint(tasks: readonly BranchLane['tasks'][number][], taskId: number): boolean {
    const nextIndex = tasks.findIndex((task) => task.status === 'TODO');
    return nextIndex > 0 && tasks[nextIndex - 1]?.id === taskId;
  }

  private statusLabel(status: TaskStatus): string {
    return status.replaceAll('_', ' ').toLowerCase();
  }

  private laneHasProtectedPointerTasks(lane: BranchLane): boolean {
    return lane.tasks.some((task) => POINTER_RESET_BLOCKING_STATUSES.has(task.status));
  }

  private pointerResetBoundaryIndex(lane: BranchLane): number {
    const pointerResetTaskId = lane.feature?.pointer_reset_task_id;
    if (pointerResetTaskId === null || pointerResetTaskId === undefined) return lane.tasks.length;
    const firstPostResetTaskIndex = lane.tasks.findIndex((task) => task.id > pointerResetTaskId);
    return firstPostResetTaskIndex < 0 ? lane.tasks.length : firstPostResetTaskIndex;
  }

  private isManagedBranch(branchName: string): boolean {
    return /^(?:agent|feature)\//u.test(branchName);
  }

  private firstLine(value: string): string {
    return value.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim().toLocaleLowerCase() ?? '';
  }

  private readZoomSensitivity(projectId: number): number {
    try {
      const sensitivity = Number(globalThis.localStorage?.getItem(`${ZOOM_SENSITIVITY_STORAGE_PREFIX}${projectId}`));
      return ZOOM_SENSITIVITIES.some((option) => option === sensitivity) ? sensitivity : 1;
    } catch {
      return 1;
    }
  }
}
