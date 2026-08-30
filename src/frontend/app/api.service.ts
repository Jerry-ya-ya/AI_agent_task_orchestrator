import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import {
  CreateProjectInput,
  AgentUsage,
  HealthResponse,
  Project,
  SaveTaskInput,
  Task,
  TaskDetail,
  TaskRun,
} from './models';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:4317';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
    return (url.protocol === 'http:' || url.protocol === 'https:') && loopbackHosts.has(url.hostname);
  } catch {
    return false;
  }
}

export function resolveApiBaseUrl(locationRef: Location = window.location): string {
  const queryValue = new URLSearchParams(locationRef.search).get('apiBaseUrl')?.trim();
  if (queryValue && isLoopbackHttpUrl(queryValue)) {
    return stripTrailingSlash(queryValue);
  }

  const isAngularDevServer =
    (locationRef.hostname === '127.0.0.1' || locationRef.hostname === 'localhost') &&
    locationRef.port === '4200';
  if (
    !isAngularDevServer &&
    locationRef.origin !== 'null' &&
    isLoopbackHttpUrl(locationRef.origin)
  ) {
    return stripTrailingSlash(locationRef.origin);
  }

  return DEFAULT_API_BASE_URL;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  readonly baseUrl = resolveApiBaseUrl();

  constructor(private readonly http: HttpClient) {}

  getHealth(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(`${this.baseUrl}/health`);
  }

  getAgentUsage(): Observable<AgentUsage> {
    return this.http.get<AgentUsage>(`${this.baseUrl}/agent/usage`);
  }

  getProjects(): Observable<Project[]> {
    return this.http.get<Project[]>(`${this.baseUrl}/projects`);
  }

  createProject(input: CreateProjectInput): Observable<Project> {
    return this.http.post<Project>(`${this.baseUrl}/projects`, input);
  }

  getTasks(): Observable<Task[]> {
    return this.http.get<Task[]>(`${this.baseUrl}/tasks`);
  }

  getTask(taskId: number): Observable<TaskDetail> {
    return this.http.get<TaskDetail>(`${this.baseUrl}/tasks/${taskId}`);
  }

  createTask(input: SaveTaskInput): Observable<Task> {
    return this.http.post<Task>(`${this.baseUrl}/tasks`, input);
  }

  updateTask(taskId: number, input: SaveTaskInput): Observable<Task> {
    return this.http.put<Task>(`${this.baseUrl}/tasks/${taskId}`, input);
  }

  deleteTask(taskId: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/tasks/${taskId}`);
  }

  approveTask(taskId: number): Observable<Task> {
    return this.http.post<Task>(`${this.baseUrl}/tasks/${taskId}/approve`, {});
  }

  retryTask(taskId: number): Observable<Task> {
    return this.http.post<Task>(`${this.baseUrl}/tasks/${taskId}/retry`, {});
  }

  pauseTask(taskId: number): Observable<Task> {
    return this.http.post<Task>(`${this.baseUrl}/tasks/${taskId}/pause`, {});
  }

  resumeTask(taskId: number): Observable<Task> {
    return this.http.post<Task>(`${this.baseUrl}/tasks/${taskId}/resume`, {});
  }

  getTaskRuns(taskId: number): Observable<TaskRun[]> {
    return this.http.get<TaskRun[]>(`${this.baseUrl}/tasks/${taskId}/runs`);
  }
}
