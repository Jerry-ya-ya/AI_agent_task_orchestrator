import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectorRef,
  Component,
  ViewEncapsulation,
  HostListener,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from './api.service';
import { AppHeaderComponent } from './components/app-header/app-header.component';
import { AppNavigationComponent, type AppPage } from './components/app-navigation/app-navigation.component';
import { FeatureEditorDialogComponent } from './components/feature-editor-dialog/feature-editor-dialog.component';
import { FeatureMapComponent } from './components/feature-map/feature-map.component';
import { ProjectEditorDialogComponent } from './components/project-editor-dialog/project-editor-dialog.component';
import { RetryReviewDialogComponent } from './components/retry-review-dialog/retry-review-dialog.component';
import { RetryTaskDialogComponent, type RetryTaskRequest } from './components/retry-task-dialog/retry-task-dialog.component';
import { TaskBoardComponent } from './components/task-board/task-board.component';
import { TaskDetailDialogComponent } from './components/task-detail-dialog/task-detail-dialog.component';
import { TaskEditorDialogComponent } from './components/task-editor-dialog/task-editor-dialog.component';
import { TaskHistoryComponent } from './components/task-history/task-history.component';
import {
  AgentUsage,
  Feature,
  FeatureDraft,
  MODEL_EFFORTS,
  Project,
  ProjectDraft,
  ProjectBranchMap,
  SaveTaskInput,
  StatusColumn,
  TASK_PRIORITIES,
  Task,
  TaskDetail,
  TaskDraft,
  WorkerStatus,
} from './models';

type TaskEditorMode = 'create' | 'edit';

const STATUS_COLUMNS: readonly StatusColumn[] = [
  { status: 'TODO', label: 'Todo', hint: 'Waiting for the worker' },
  { status: 'IN_PROGRESS', label: 'In progress', hint: 'Agent is working' },
  { status: 'TESTING', label: 'Testing', hint: 'Running project checks' },
  { status: 'IN_REVIEW', label: 'In review', hint: 'Ready for your review' },
  { status: 'PENDING_PUSH', label: 'Pending push', hint: 'Approved; waiting to publish' },
  { status: 'PENDING_BRANCH_REMOVAL', label: 'Remove branch', hint: 'Legacy branch cleanup' },
  { status: 'DONE', label: 'Done', hint: 'Published checkpoint' },
  { status: 'REJECTED', label: 'Rejected', hint: 'Declined during review' },
  { status: 'FAILED', label: 'Failed', hint: 'Needs attention' },
];

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    AppHeaderComponent,
    AppNavigationComponent,
    FeatureMapComponent,
    FeatureEditorDialogComponent,
    TaskBoardComponent,
    TaskHistoryComponent,
    ProjectEditorDialogComponent,
    TaskEditorDialogComponent,
    RetryTaskDialogComponent,
    RetryReviewDialogComponent,
    TaskDetailDialogComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  encapsulation: ViewEncapsulation.None,
})
export class AppComponent implements OnInit, OnDestroy {
  readonly columns = STATUS_COLUMNS;
  readonly priorities = TASK_PRIORITIES;
  readonly modelEfforts = MODEL_EFFORTS;
  readonly apiBaseUrl: string;

  projects: Project[] = [];
  features: Feature[] = [];
  branchMaps: ProjectBranchMap[] = [];
  tasks: Task[] = [];
  workerStatus: WorkerStatus | null = null;
  agentUsage: AgentUsage | null = null;
  connected = false;
  loading = true;
  saving = false;
  detailLoading = false;
  apiError = '';
  notice = '';
  lastUpdated: Date | null = null;
  activePage: AppPage = 'taskboard';
  navigationExpanded = false;

  showProjectEditor = false;
  showFeatureEditor = false;
  taskEditorMode: TaskEditorMode | null = null;
  editingTaskId: number | null = null;
  selectedTaskId: number | null = null;
  selectedTaskDetail: TaskDetail | null = null;
  retryingTask: Task | null = null;
  retryReviewTaskId: number | null = null;
  projectDraft: ProjectDraft = this.emptyProjectDraft();
  featureDraft: FeatureDraft = this.emptyFeatureDraft();
  taskDraft: TaskDraft = this.emptyTaskDraft();

  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private usagePollingTimer: ReturnType<typeof setInterval> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight = false;
  private healthRefreshInFlight = false;
  private usageRefreshInFlight = false;
  branchMapRefreshInFlight = false;
  pendingTaskIds = new Set<number>();
  private restoreFocusTo: HTMLElement | null = null;

  constructor(
    private readonly api: ApiService,
    private readonly changeDetector: ChangeDetectorRef,
  ) {
    this.apiBaseUrl = api.baseUrl;
  }

  ngOnInit(): void {
    void this.refreshBoard(false);
    void this.refreshAgentUsage();
    this.pollingTimer = setInterval(() => {
      void this.refreshBoard(true);
    }, 2_000);
    this.usagePollingTimer = setInterval(() => {
      void this.refreshAgentUsage();
    }, 60_000);
  }

  ngOnDestroy(): void {
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
    }
    if (this.usagePollingTimer !== null) {
      clearInterval(this.usagePollingTimer);
    }
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
    }
    document.body.classList.remove('modal-open');
  }

  closeApplication(): void {
    if (window.desktopWindow) {
      void window.desktopWindow.close();
      return;
    }

    window.close();
  }

  minimizeApplication(): void {
    void window.desktopWindow?.minimize?.();
  }

  selectPage(page: AppPage): void {
    this.activePage = page;
    if (page === 'features') void this.refreshBranchMap();
  }

  setNavigationExpanded(expanded: boolean): void {
    this.navigationExpanded = expanded;
  }

  historyTaskCount(): number {
    return this.tasks.filter((task) =>
      task.status === 'DONE' || task.status === 'REJECTED' || task.status === 'FAILED'
    ).length;
  }

  @HostListener('document:keydown', ['$event'])
  handleDocumentKeydown(event: KeyboardEvent): void {
    if (!this.hasOpenModal()) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeModal();
      return;
    }

    if (event.key === 'Tab') {
      this.keepFocusInModal(event);
    }
  }

  openProjectEditor(): void {
    this.clearError();
    this.projectDraft = this.emptyProjectDraft();
    this.showProjectEditor = true;
    this.activateModal();
  }

  openCreateTask(): void {
    if (this.projects.length === 0) {
      this.openProjectEditor();
      return;
    }
    if (this.features.length === 0) {
      this.activePage = 'features';
      this.openFeatureEditor();
      return;
    }

    this.clearError();
    this.editingTaskId = null;
    this.taskDraft = this.emptyTaskDraft();
    this.taskEditorMode = 'create';
    this.activateModal();
  }

  openEditTask(task: Task): void {
    if (!this.canModifyTask(task)) {
      return;
    }
    this.closeModal(false);
    this.clearError();
    this.editingTaskId = task.id;
    this.taskDraft = {
      project_id: task.project_id,
      feature_id: task.feature_id ?? null,
      title: task.title,
      description: task.description,
      priority: task.priority,
      model_effort: task.model_effort,
    };
    this.taskEditorMode = 'edit';
    this.activateModal();
  }

  openTaskDetail(task: Task): void {
    this.clearError();
    this.selectedTaskId = task.id;
    this.selectedTaskDetail = null;
    this.detailLoading = true;
    this.activateModal();
    void this.loadTaskDetail(task.id, false);
  }

  closeModal(restoreFocus = true): void {
    this.showProjectEditor = false;
    this.showFeatureEditor = false;
    this.taskEditorMode = null;
    this.editingTaskId = null;
    this.selectedTaskId = null;
    this.selectedTaskDetail = null;
    this.retryingTask = null;
    this.retryReviewTaskId = null;
    this.detailLoading = false;
    this.saving = false;
    this.clearError();
    document.body.classList.remove('modal-open');

    if (restoreFocus) {
      const target = this.restoreFocusTo;
      this.restoreFocusTo = null;
      setTimeout(() => target?.focus());
    }
  }

  async saveProject(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.clearError();
    try {
      const created = await firstValueFrom(
        this.api.createProject({
          name: this.projectDraft.name.trim(),
          repository_path: this.projectDraft.repository_path.trim(),
          context: this.projectDraft.context.trim() || undefined,
        }),
      );
      this.projects = [...this.projects, created];
      this.closeModal();
      this.showNotice(`Project “${created.name}” created.`);
      await this.refreshBoard(true);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.saving = false;
      this.changeDetector.markForCheck();
    }
  }

  openFeatureEditor(): void {
    if (this.projects.length === 0) {
      this.openProjectEditor();
      return;
    }
    this.clearError();
    this.featureDraft = this.emptyFeatureDraft();
    this.showFeatureEditor = true;
    this.activateModal();
  }

  async saveFeature(): Promise<void> {
    if (this.featureDraft.project_id === null || this.saving) return;
    this.saving = true;
    this.clearError();
    try {
      const feature = await firstValueFrom(this.api.createFeature({
        project_id: this.featureDraft.project_id,
        name: this.featureDraft.name.trim(),
      }));
      this.features = [...this.features, feature];
      this.closeModal();
      this.showNotice(`Feature “${feature.name}” created.`);
      await this.refreshBranchMap();
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.saving = false;
      this.changeDetector.markForCheck();
    }
  }

  async saveTask(): Promise<void> {
    if (this.taskDraft.project_id === null || this.taskDraft.feature_id === null || this.saving) return;

    const input: SaveTaskInput = {
      project_id: this.taskDraft.project_id,
      feature_id: this.taskDraft.feature_id,
      title: this.taskDraft.title.trim(),
      description: this.taskDraft.description.trim(),
      priority: this.taskDraft.priority,
      model_effort: this.taskDraft.model_effort,
    };

    this.saving = true;
    this.clearError();
    try {
      if (this.taskEditorMode === 'edit' && this.editingTaskId !== null) {
        await firstValueFrom(this.api.updateTask(this.editingTaskId, input));
        this.showNotice('Task updated.');
      } else {
        await firstValueFrom(this.api.createTask(input));
        this.showNotice('Task added to Todo.');
      }
      this.closeModal();
      await this.refreshBoard(false);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.saving = false;
      this.changeDetector.markForCheck();
    }
  }

  async approveTask(task: Task, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (this.isTaskPending(task.id)) {
      return;
    }

    this.setTaskPending(task.id, true);
    this.clearError();
    try {
      await firstValueFrom(this.api.approveTask(task.id));
      this.showNotice(`“${task.title}” is ready to push.`);
      await this.refreshBoard(false);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.setTaskPending(task.id, false);
      this.changeDetector.markForCheck();
    }
  }

  onModalBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closeModal();
    }
  }

  openRetryReview(task: Task, event?: Event): void {
    event?.stopPropagation();
    if (task.status !== 'IN_REVIEW' || this.isTaskPending(task.id)) {
      return;
    }
    this.closeModal(false);
    this.clearError();
    this.retryReviewTaskId = task.id;
    this.activateModal();
  }

  async submitReviewRetry(prompt: string): Promise<void> {
    if (this.retryReviewTaskId === null || this.saving) return;
    const task = this.tasks.find((item) => item.id === this.retryReviewTaskId);
    if (!task) return;
    this.saving = true;
    this.clearError();
    try {
      await firstValueFrom(this.api.retryReviewTask(task.id, prompt));
      this.closeModal();
      this.showNotice(`A revision of “${task.title}” was queued.`);
      await this.refreshBoard(false);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.saving = false;
      this.changeDetector.markForCheck();
    }
  }

  async rejectTask(task: Task, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (this.isTaskPending(task.id)) return;
    const activeWarning = ['CLAIMED', 'IN_PROGRESS', 'TESTING'].includes(task.status)
      ? ' This will stop the current run.'
      : '';
    const branchWarning = task.feature_id
      ? ' The shared Feature branch will be kept for its other tasks.'
      : ' Any task branch will wait for removal approval.';
    if (!window.confirm(`Reject “${task.title}”?${activeWarning}${branchWarning}`)) return;
    this.setTaskPending(task.id, true);
    this.clearError();
    try {
      await firstValueFrom(this.api.rejectTask(task.id));
      if (this.selectedTaskId === task.id) this.closeModal();
      this.showNotice(task.feature_id
        ? `“${task.title}” rejected; its shared Feature branch was retained.`
        : `“${task.title}” rejected and queued for branch removal.`);
      await this.refreshBoard(false);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.setTaskPending(task.id, false);
      this.changeDetector.markForCheck();
    }
  }

  async pushTask(task: Task, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (task.status !== 'PENDING_PUSH' || this.isTaskPending(task.id)) {
      return;
    }

    const baseBranch = task.base_branch || 'the current base branch';
    const confirmed = window.confirm(task.feature_id
      ? `Push “${task.title}” to the shared feature branch ${task.branch_name}?`
      : `Merge “${task.title}” into ${baseBranch} and push it to origin?`);
    if (!confirmed) {
      return;
    }

    this.setTaskPending(task.id, true);
    this.clearError();
    try {
      await firstValueFrom(this.api.pushTask(task.id));
      this.showNotice(task.feature_id
        ? `“${task.title}” published to ${task.branch_name}.`
        : `“${task.title}” pushed; branch cleanup is awaiting approval.`);
      await this.refreshBoard(false);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.setTaskPending(task.id, false);
      this.changeDetector.markForCheck();
    }
  }

  async removeTaskBranch(task: Task, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (task.status !== 'PENDING_BRANCH_REMOVAL' || this.isTaskPending(task.id)) {
      return;
    }

    const confirmed = window.confirm(
      `Remove the local task branch ${task.branch_name || ''} for “${task.title}”?`,
    );
    if (!confirmed) {
      return;
    }

    this.setTaskPending(task.id, true);
    this.clearError();
    try {
      await firstValueFrom(this.api.removeTaskBranch(task.id));
      this.showNotice(`“${task.title}” branch removed and task marked Done.`);
      await this.refreshBoard(false);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.setTaskPending(task.id, false);
      this.changeDetector.markForCheck();
    }
  }

  openRetryTask(task: Task, event?: Event): void {
    event?.stopPropagation();
    if (this.isTaskPending(task.id)) {
      return;
    }

    this.closeModal(false);
    this.clearError();
    this.retryingTask = task;
    this.activateModal();
  }

  async retryTask(request: RetryTaskRequest): Promise<void> {
    const task = this.retryingTask;
    if (task === null || this.isTaskPending(task.id)) return;

    this.setTaskPending(task.id, true);
    this.clearError();
    try {
      await firstValueFrom(this.api.retryTask(
        task.id,
        request.prompt,
        request.modelEffort
      ));
      this.showNotice(`“${task.title}” queued for retry.`);
      this.closeModal();
      await this.refreshBoard(false);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.setTaskPending(task.id, false);
      this.changeDetector.markForCheck();
    }
  }

  async toggleTaskPause(task: Task, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (task.status !== 'TODO' || this.isTaskPending(task.id)) {
      return;
    }

    this.setTaskPending(task.id, true);
    this.clearError();
    try {
      if (task.is_paused) {
        await firstValueFrom(this.api.resumeTask(task.id));
        this.showNotice(`“${task.title}” resumed.`);
      } else {
        await firstValueFrom(this.api.pauseTask(task.id));
        this.showNotice(`“${task.title}” paused in Todo.`);
      }
      await this.refreshBoard(false);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.setTaskPending(task.id, false);
      this.changeDetector.markForCheck();
    }
  }

  async deleteTask(task: Task, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (this.isTaskPending(task.id)) {
      return;
    }

    const confirmed = window.confirm(
      `Delete “${task.title}”? Its database history will be removed, but its Git branch is retained.`,
    );
    if (!confirmed) {
      return;
    }

    this.setTaskPending(task.id, true);
    this.clearError();
    try {
      await firstValueFrom(this.api.deleteTask(task.id));
      if (this.selectedTaskId === task.id) {
        this.closeModal();
      }
      this.showNotice('Task deleted.');
      await this.refreshBoard(false);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.setTaskPending(task.id, false);
      this.changeDetector.markForCheck();
    }
  }

  isTaskPending(taskId: number): boolean {
    return this.pendingTaskIds.has(taskId);
  }

  canModifyTask(task: Task): boolean {
    return task.status !== 'CLAIMED' &&
      task.status !== 'IN_PROGRESS' &&
      task.status !== 'TESTING' &&
      task.status !== 'PENDING_PUSH' &&
      task.status !== 'PENDING_BRANCH_REMOVAL';
  }

  taskForDetail(): Task | null {
    if (this.selectedTaskDetail) {
      return this.selectedTaskDetail;
    }
    return this.tasks.find((task) => task.id === this.selectedTaskId) ?? null;
  }

  openTaskDetailById(taskId: number): void {
    const task = this.tasks.find((item) => item.id === taskId);
    if (task) this.openTaskDetail(task);
  }

  workerWarning(): string {
    if (this.workerStatus === null || !this.workerStatus.running) {
      return this.workerStatus?.message ?? '';
    }
    return this.workerStatus.agentAvailable ? '' : this.workerStatus.message;
  }

  private async refreshBoard(silent: boolean): Promise<void> {
    if (this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = true;
    void this.refreshWorkerStatus();
    if (!silent) {
      this.loading = true;
    }

    try {
      const [projects, features, tasks] = await Promise.all([
        firstValueFrom(this.api.getProjects()),
        firstValueFrom(this.api.getFeatures()),
        firstValueFrom(this.api.getTasks()),
      ]);
      this.projects = projects;
      this.features = features;
      this.tasks = tasks;
      this.connected = true;
      this.lastUpdated = new Date();
      if (!this.hasOpenModal()) {
        this.clearError();
      }

      if (this.selectedTaskId !== null) {
        await this.loadTaskDetail(this.selectedTaskId, true);
      }
      if (this.activePage === 'features') {
        await this.refreshBranchMap();
      }
    } catch (error: unknown) {
      this.connected = false;
      if (!silent || this.tasks.length === 0) {
        this.setError(this.errorMessage(error));
      }
    } finally {
      this.loading = false;
      this.refreshInFlight = false;
      this.changeDetector.markForCheck();
    }
  }

  private async refreshWorkerStatus(): Promise<void> {
    if (this.healthRefreshInFlight) {
      return;
    }

    this.healthRefreshInFlight = true;
    try {
      const health = await firstValueFrom(this.api.getHealth());
      this.workerStatus = health.worker;
    } catch {
      // Health is supplementary; a transient failure must not block task and project updates.
      this.workerStatus = null;
    } finally {
      this.healthRefreshInFlight = false;
      this.changeDetector.markForCheck();
    }
  }

  private async refreshAgentUsage(): Promise<void> {
    if (this.usageRefreshInFlight) {
      return;
    }
    this.usageRefreshInFlight = true;
    try {
      this.agentUsage = await firstValueFrom(this.api.getAgentUsage());
    } catch (error: unknown) {
      this.agentUsage = {
        available: false,
        planType: null,
        primary: null,
        secondary: null,
        resetCredits: null,
        checkedAt: new Date().toISOString(),
        message: this.errorMessage(error),
      };
    } finally {
      this.usageRefreshInFlight = false;
      this.changeDetector.markForCheck();
    }
  }

  private async refreshBranchMap(): Promise<void> {
    if (this.branchMapRefreshInFlight) return;
    this.branchMapRefreshInFlight = true;
    try {
      this.branchMaps = await firstValueFrom(this.api.getBranchMap());
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.branchMapRefreshInFlight = false;
      this.changeDetector.markForCheck();
    }
  }

  private async loadTaskDetail(taskId: number, silent: boolean): Promise<void> {
    if (!silent) {
      this.detailLoading = true;
    }

    try {
      const detail = await firstValueFrom(this.api.getTask(taskId));
      if (this.selectedTaskId === taskId) {
        this.selectedTaskDetail = detail;
      }
    } catch (error: unknown) {
      if (!silent) {
        this.setError(this.errorMessage(error));
      }
    } finally {
      if (this.selectedTaskId === taskId) {
        this.detailLoading = false;
      }
      this.changeDetector.markForCheck();
    }
  }

  private activateModal(): void {
    this.restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add('modal-open');
    setTimeout(() => document.querySelector<HTMLElement>('.modal__surface')?.focus());
  }

  private hasOpenModal(): boolean {
    return this.showProjectEditor || this.showFeatureEditor || this.taskEditorMode !== null ||
      this.selectedTaskId !== null || this.retryingTask !== null ||
      this.retryReviewTaskId !== null;
  }

  private keepFocusInModal(event: KeyboardEvent): void {
    const modal = document.querySelector<HTMLElement>('.modal__surface');
    if (!modal) {
      return;
    }

    const focusable = Array.from(
      modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute('hidden'));

    if (focusable.length === 0) {
      event.preventDefault();
      modal.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private emptyProjectDraft(): ProjectDraft {
    return { name: '', repository_path: '', context: '' };
  }

  private emptyTaskDraft(): TaskDraft {
    const projectId = this.projects[0]?.id ?? null;
    return {
      project_id: projectId,
      feature_id: this.features.find((feature) => feature.project_id === projectId)?.id ?? null,
      title: '',
      description: '',
      priority: 'MEDIUM',
      model_effort: 'medium',
    };
  }

  private emptyFeatureDraft(): FeatureDraft {
    return { project_id: this.projects[0]?.id ?? null, name: '' };
  }

  private setTaskPending(taskId: number, pending: boolean): void {
    const next = new Set(this.pendingTaskIds);
    if (pending) {
      next.add(taskId);
    } else {
      next.delete(taskId);
    }
    this.pendingTaskIds = next;
  }

  private clearError(): void {
    this.apiError = '';
  }

  private setError(message: string): void {
    this.apiError = message;
  }

  private showNotice(message: string): void {
    this.notice = message;
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => {
      this.notice = '';
      this.changeDetector.markForCheck();
    }, 4_000);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const payload = error.error as { error?: string; message?: string } | string | null;
      if (typeof payload === 'string' && payload.trim()) {
        return payload;
      }
      if (payload && typeof payload === 'object') {
        if (typeof payload.message === 'string') {
          return payload.message;
        }
        if (typeof payload.error === 'string') {
          return payload.error;
        }
      }
      if (error.status === 0) {
        return `Cannot reach the local backend at ${this.apiBaseUrl}.`;
      }
      return error.message || `Request failed (${error.status}).`;
    }

    return error instanceof Error ? error.message : 'Something went wrong.';
  }
}
