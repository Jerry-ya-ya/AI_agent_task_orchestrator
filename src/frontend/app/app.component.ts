import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { ApiService } from './api.service';
import {
  Project,
  ProjectDraft,
  SaveTaskInput,
  TASK_PRIORITIES,
  TASK_STATUSES,
  Task,
  TaskDetail,
  TaskDraft,
  TaskPriority,
  TaskRun,
  TaskStatus,
  WorkerStatus,
} from './models';

type TaskEditorMode = 'create' | 'edit';

interface StatusColumn {
  status: TaskStatus;
  label: string;
  hint: string;
}

const STATUS_COLUMNS: readonly StatusColumn[] = [
  { status: 'TODO', label: 'Todo', hint: 'Waiting for the worker' },
  { status: 'CLAIMED', label: 'Claimed', hint: 'Reserved by the worker' },
  { status: 'IN_PROGRESS', label: 'In progress', hint: 'Agent is working' },
  { status: 'TESTING', label: 'Testing', hint: 'Running project checks' },
  { status: 'IN_REVIEW', label: 'In review', hint: 'Ready for your review' },
  { status: 'DONE', label: 'Done', hint: 'Approved work' },
  { status: 'FAILED', label: 'Failed', hint: 'Needs attention' },
];

const PRIORITY_WEIGHT: Readonly<Record<TaskPriority, number>> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  URGENT: 4,
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('modalSurface') private modalSurface?: ElementRef<HTMLElement>;

  readonly columns = STATUS_COLUMNS;
  readonly priorities = TASK_PRIORITIES;
  readonly apiBaseUrl: string;

  projects: Project[] = [];
  tasks: Task[] = [];
  workerStatus: WorkerStatus | null = null;
  connected = false;
  loading = true;
  saving = false;
  detailLoading = false;
  apiError = '';
  notice = '';
  lastUpdated: Date | null = null;

  showProjectEditor = false;
  taskEditorMode: TaskEditorMode | null = null;
  editingTaskId: number | null = null;
  selectedTaskId: number | null = null;
  selectedTaskDetail: TaskDetail | null = null;
  projectDraft: ProjectDraft = this.emptyProjectDraft();
  taskDraft: TaskDraft = this.emptyTaskDraft();

  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight = false;
  private healthRefreshInFlight = false;
  private pendingTaskIds = new Set<number>();
  private restoreFocusTo: HTMLElement | null = null;

  constructor(
    private readonly api: ApiService,
    private readonly changeDetector: ChangeDetectorRef,
  ) {
    this.apiBaseUrl = api.baseUrl;
  }

  ngOnInit(): void {
    void this.refreshBoard(false);
    this.pollingTimer = setInterval(() => {
      void this.refreshBoard(true);
    }, 2_000);
  }

  ngOnDestroy(): void {
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
    }
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
    }
    document.body.classList.remove('modal-open');
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

  tasksFor(status: TaskStatus): Task[] {
    return this.tasks
      .filter((task) => task.status === status)
      .sort((left, right) => {
        const priorityDifference = PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority];
        return priorityDifference || left.created_at.localeCompare(right.created_at);
      });
  }

  projectName(projectId: number): string {
    return this.projects.find((project) => project.id === projectId)?.name ?? 'Unknown project';
  }

  trackTask(_index: number, task: Task): number {
    return task.id;
  }

  trackRun(_index: number, run: TaskRun): number {
    return run.id;
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
      title: task.title,
      description: task.description,
      priority: task.priority,
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
    this.taskEditorMode = null;
    this.editingTaskId = null;
    this.selectedTaskId = null;
    this.selectedTaskDetail = null;
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

  async saveProject(form: NgForm): Promise<void> {
    if (form.invalid || this.saving) {
      form.control.markAllAsTouched();
      return;
    }

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

  async saveTask(form: NgForm): Promise<void> {
    if (form.invalid || this.taskDraft.project_id === null || this.saving) {
      form.control.markAllAsTouched();
      return;
    }

    const input: SaveTaskInput = {
      project_id: this.taskDraft.project_id,
      title: this.taskDraft.title.trim(),
      description: this.taskDraft.description.trim(),
      priority: this.taskDraft.priority,
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
      this.showNotice(`“${task.title}” marked Done.`);
      await this.refreshBoard(false);
    } catch (error: unknown) {
      this.setError(this.errorMessage(error));
    } finally {
      this.setTaskPending(task.id, false);
      this.changeDetector.markForCheck();
    }
  }

  async retryTask(task: Task, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (this.isTaskPending(task.id)) {
      return;
    }

    this.setTaskPending(task.id, true);
    this.clearError();
    try {
      await firstValueFrom(this.api.retryTask(task.id));
      this.showNotice(`“${task.title}” queued for retry.`);
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
    return task.status !== 'CLAIMED' && task.status !== 'IN_PROGRESS' && task.status !== 'TESTING';
  }

  latestResult(task: Task): string {
    const summary = task.latest_run?.result_summary?.trim();
    if (summary) {
      return summary;
    }

    if (task.status === 'CLAIMED' || task.status === 'IN_PROGRESS' || task.status === 'TESTING') {
      return 'Worker is processing this task.';
    }

    return 'No execution result yet.';
  }

  taskForDetail(): Task | null {
    if (this.selectedTaskDetail) {
      return this.selectedTaskDetail;
    }
    return this.tasks.find((task) => task.id === this.selectedTaskId) ?? null;
  }

  statusLabel(status: TaskStatus): string {
    return this.columns.find((column) => column.status === status)?.label ?? status;
  }

  workerStateLabel(): string {
    if (!this.connected) {
      return 'Worker unknown';
    }
    if (this.workerStatus === null) {
      return 'Worker status unavailable';
    }
    if (!this.workerStatus.running) {
      return 'Worker stopped';
    }
    if (!this.workerStatus.agentAvailable) {
      return 'Agent unavailable';
    }
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

  workerWarning(): string {
    if (this.workerStatus === null || !this.workerStatus.running) {
      return this.workerStatus?.message ?? '';
    }
    return this.workerStatus.agentAvailable ? '' : this.workerStatus.message;
  }

  runLabel(run: TaskRun, index: number, total: number): string {
    const attempt = total - index;
    return `Attempt ${attempt}`;
  }

  hasOutput(value: string | null | undefined): boolean {
    return Boolean(value?.trim());
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
      const [projects, tasks] = await Promise.all([
        firstValueFrom(this.api.getProjects()),
        firstValueFrom(this.api.getTasks()),
      ]);
      this.projects = projects;
      this.tasks = tasks;
      this.connected = true;
      this.lastUpdated = new Date();
      if (!this.hasOpenModal()) {
        this.clearError();
      }

      if (this.selectedTaskId !== null) {
        await this.loadTaskDetail(this.selectedTaskId, true);
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
    setTimeout(() => this.modalSurface?.nativeElement.focus());
  }

  private hasOpenModal(): boolean {
    return this.showProjectEditor || this.taskEditorMode !== null || this.selectedTaskId !== null;
  }

  private keepFocusInModal(event: KeyboardEvent): void {
    const modal = this.modalSurface?.nativeElement;
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
    return {
      project_id: this.projects[0]?.id ?? null,
      title: '',
      description: '',
      priority: 'MEDIUM',
    };
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
