import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { CodexAgentExecutor } from './agents/codex-agent-executor.js';
import { CodexUsageService } from './agents/codex-usage-service.js';
import type { AgentExecutor } from './agents/agent-executor.js';
import { createApi } from './api/create-api.js';
import { OrchestratorDatabase } from './database/database.js';
import { ProjectRepository } from './database/project-repository.js';
import { FeatureRepository } from './database/feature-repository.js';
import { TaskRepository } from './database/task-repository.js';
import { TaskRunRepository } from './database/task-run-repository.js';
import { ProcessRunner } from './infra/process-runner.js';
import { GitService } from './services/git-service.js';
import { FeatureService } from './services/feature-service.js';
import { ProjectService } from './services/project-service.js';
import { TaskService } from './services/task-service.js';
import { TestService } from './services/test-service.js';
import { TaskWorker } from './worker/task-worker.js';

export interface RuntimeOptions {
  databasePath: string;
  port?: number;
  uiPath?: string;
  pollIntervalMs?: number;
  agent?: AgentExecutor;
  gitService?: GitService;
  testService?: TestService;
}

export class OrchestratorRuntime {
  public readonly database: OrchestratorDatabase;
  public readonly worker: TaskWorker;
  public readonly projectService: ProjectService;
  public readonly taskService: TaskService;
  public readonly featureService: FeatureService;
  private readonly server: Server;
  private readonly port: number;
  private started = false;
  private stopped = false;
  private baseUrlValue: string | null = null;

  public constructor(options: RuntimeOptions) {
    this.port = options.port ?? 0;
    this.database = new OrchestratorDatabase(options.databasePath);
    const processRunner = new ProcessRunner();
    const git = options.gitService ?? new GitService(processRunner);
    const tests = options.testService ?? new TestService(processRunner);
    const agent = options.agent ?? new CodexAgentExecutor(processRunner);
    const agentUsage = new CodexUsageService();
    const projects = new ProjectRepository(this.database);
    const features = new FeatureRepository(this.database);
    const runs = new TaskRunRepository(this.database);
    const tasks = new TaskRepository(this.database, runs);
    this.projectService = new ProjectService(projects, git);
    this.taskService = new TaskService(tasks, projects, runs, git, features);
    this.featureService = new FeatureService(features, projects, tasks, git);
    tasks.recoverInterrupted();
    this.worker = new TaskWorker(tasks, runs, git, agent, tests, {
      pollIntervalMs: options.pollIntervalMs
    });

    const api = createApi({
      projectService: this.projectService,
      taskService: this.taskService,
      featureService: this.featureService,
      workerStatus: () => this.worker.getStatus(),
      pauseWorker: () => this.worker.pause(),
      resumeWorker: () => this.worker.resume(),
      agentUsage: () => agentUsage.read(),
      cancelTask: (taskId) => this.worker.cancelTask(taskId)
    });
    if (options.uiPath !== undefined && existsSync(options.uiPath)) {
      api.use(express.static(options.uiPath));
      api.use((request, response, next) => {
        if (request.method === 'GET' && request.accepts('html')) {
          response.sendFile(join(options.uiPath as string, 'index.html'));
          return;
        }
        next();
      });
    }
    this.server = createServer(api);
  }

  public get baseUrl(): string {
    if (this.baseUrlValue === null) {
      throw new Error('Runtime has not started yet.');
    }
    return this.baseUrlValue;
  }

  public async start(): Promise<string> {
    if (this.started) {
      return this.baseUrl;
    }
    if (this.stopped) {
      throw new Error('A stopped runtime cannot be restarted.');
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    this.baseUrlValue = `http://127.0.0.1:${address.port}`;
    this.started = true;
    this.worker.start();
    return this.baseUrlValue;
  }

  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.worker.stop();
    if (this.started) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
    this.database.close();
  }
}
