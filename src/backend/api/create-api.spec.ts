import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { OrchestratorDatabase } from '../database/database.js';
import { ProjectRepository } from '../database/project-repository.js';
import { TaskRepository } from '../database/task-repository.js';
import { TaskRunRepository } from '../database/task-run-repository.js';
import { ProcessRunner } from '../infra/process-runner.js';
import { GitService } from '../services/git-service.js';
import { ProjectService } from '../services/project-service.js';
import { TaskService } from '../services/task-service.js';
import { createApi } from './create-api.js';

describe('backend API', () => {
  let temporaryRoot: string;
  let repositoryPath: string;
  let database: OrchestratorDatabase;
  let tasks: TaskRepository;
  let app: ReturnType<typeof createApi>;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'orchestrator-api-'));
    repositoryPath = path.join(temporaryRoot, 'repository');
    await mkdir(repositoryPath);
    execFileSync('git', ['init', '--quiet', repositoryPath], {
      windowsHide: true,
      stdio: 'pipe'
    });

    database = new OrchestratorDatabase(path.join(temporaryRoot, 'orchestrator.sqlite'));
    const projects = new ProjectRepository(database);
    const runs = new TaskRunRepository(database);
    tasks = new TaskRepository(database, runs);
    const git = new GitService(new ProcessRunner());
    app = createApi({
      projectService: new ProjectService(projects, git),
      taskService: new TaskService(tasks, projects, runs, git),
      workerStatus: () => ({
        running: true,
        busy: false,
        activeTaskId: null,
        agentAvailable: true,
        message: 'Codex CLI is available.'
      }),
      agentUsage: async () => ({
        available: true,
        planType: 'plus',
        primary: {
          remainingPercent: 75,
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_788_108_000
        },
        secondary: null,
        resetCredits: 1,
        checkedAt: '2026-08-31T00:00:00.000Z',
        message: 'Codex usage is available.'
      })
    });
  });

  afterEach(async () => {
    database.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('creates a real Git-backed project and exposes the task lifecycle endpoints', async () => {
    const projectResponse = await request(app)
      .post('/projects')
      .send({
        name: '  Local app  ',
        repository_path: repositoryPath,
        context: '  Use the existing conventions.  '
      })
      .expect(201);

    expect(projectResponse.body).toMatchObject({
      name: 'Local app',
      repository_path: await realpath(repositoryPath),
      context: 'Use the existing conventions.'
    });

    const taskResponse = await request(app)
      .post('/tasks')
      .send({
        project_id: projectResponse.body.id,
        title: '  Implement search  ',
        description: '  Add the first search endpoint.  ',
        priority: 'HIGH',
        model_effort: 'xhigh'
      })
      .expect(201);

    expect(taskResponse.body).toMatchObject({
      title: 'Implement search',
      description: 'Add the first search endpoint.',
      priority: 'HIGH',
      model_effort: 'xhigh',
      status: 'TODO'
    });

    const taskId = Number(taskResponse.body.id);
    await request(app)
      .post(`/tasks/${taskId}/pause`)
      .expect(200)
      .expect((response) => expect(response.body.is_paused).toBe(true));
    expect(tasks.claimNext()).toBeNull();
    await request(app)
      .post(`/tasks/${taskId}/resume`)
      .expect(200)
      .expect((response) => expect(response.body.is_paused).toBe(false));
    const listResponse = await request(app)
      .get('/tasks')
      .query({ project_id: projectResponse.body.id, status: 'TODO' })
      .expect(200);
    expect(listResponse.body).toHaveLength(1);
    expect(listResponse.body[0]).toMatchObject({
      id: taskId,
      project_name: 'Local app',
      latest_run: null
    });

    await request(app)
      .put(`/tasks/${taskId}`)
      .send({ priority: 'URGENT', description: 'Updated scope' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ priority: 'URGENT', description: 'Updated scope' });
      });

    await request(app).get(`/tasks/${taskId}/runs`).expect(200, []);
    await request(app)
      .get('/agent/usage')
      .expect(200)
      .expect((response) => expect(response.body.primary.remainingPercent).toBe(75));
    await request(app).post(`/tasks/${taskId}/retry`).expect(409);

    expect(tasks.transition(taskId, 'TODO', 'IN_REVIEW')).not.toBeNull();
    await request(app)
      .post(`/tasks/${taskId}/approve`)
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe('PENDING_PUSH');
      });

    await request(app).post(`/tasks/${taskId}/push`).expect(409);
    expect(tasks.transition(taskId, 'PENDING_PUSH', 'PENDING_BRANCH_REMOVAL')).not.toBeNull();
    await request(app).post(`/tasks/${taskId}/remove-branch`).expect(409);
    expect(tasks.transition(taskId, 'PENDING_BRANCH_REMOVAL', 'DONE')).not.toBeNull();

    await request(app).delete(`/tasks/${taskId}`).expect(204);
    await request(app).get(`/tasks/${taskId}`).expect(404);
  });

  it('rejects unknown command-shaped input instead of accepting executable commands', async () => {
    const projectResponse = await request(app)
      .post('/projects')
      .send({ name: 'Local app', repository_path: repositoryPath })
      .expect(201);

    await request(app)
      .post('/tasks')
      .send({
        project_id: projectResponse.body.id,
        title: 'Unsafe request',
        shell_command: 'echo this must never be accepted'
      })
      .expect(400)
      .expect((response) => {
        expect(response.body.error).toBe('VALIDATION_ERROR');
      });

    await request(app)
      .get('/tasks')
      .query({ status: 'NOT_A_STATUS' })
      .expect(400);
    await request(app)
      .put('/tasks/1')
      .send({})
      .expect(400);
    await request(app)
      .get('/tasks/not-an-id')
      .expect(400);
  });

  it('creates review revisions through the API with source lineage and rejects blank prompts', async () => {
    const projectResponse = await request(app)
      .post('/projects')
      .send({ name: 'Local app', repository_path: repositoryPath })
      .expect(201);
    const taskResponse = await request(app)
      .post('/tasks')
      .send({ project_id: projectResponse.body.id, title: 'Review this' })
      .expect(201);
    const taskId = Number(taskResponse.body.id);
    expect(tasks.transition(taskId, 'TODO', 'IN_REVIEW')).not.toBeNull();

    await request(app)
      .post(`/tasks/${taskId}/retry-review`)
      .send({ prompt: '' })
      .expect(400);
    await request(app)
      .post(`/tasks/${taskId}/retry-review`)
      .send({ prompt: '  Preserve focus after saving.  ' })
      .expect(201)
      .expect((response) => {
        expect(response.body).toMatchObject({
          status: 'TODO',
          description: 'Preserve focus after saving.',
          source_task_id: taskId
        });
      });
    expect(tasks.findById(taskId)?.status).toBe('REJECTED');
  });

  it('queues rejected review tasks for branch removal and marks the rejection', async () => {
    const projectResponse = await request(app)
      .post('/projects')
      .send({ name: 'Local app', repository_path: repositoryPath })
      .expect(201);
    const taskResponse = await request(app)
      .post('/tasks')
      .send({ project_id: projectResponse.body.id, title: 'Reject this' })
      .expect(201);
    const taskId = Number(taskResponse.body.id);
    expect(tasks.transition(taskId, 'TODO', 'IN_REVIEW')).not.toBeNull();

    await request(app)
      .post(`/tasks/${taskId}/reject`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          status: 'PENDING_BRANCH_REMOVAL',
          is_rejected: true
        });
      });
    await request(app).post(`/tasks/${taskId}/reject`).expect(409);
  });

  it('only reflects explicitly allowed local UI origins', async () => {
    await request(app)
      .get('/health')
      .set('Origin', 'http://127.0.0.1:4300')
      .expect('Access-Control-Allow-Origin', 'http://127.0.0.1:4300')
      .expect(200);

    const untrusted = await request(app)
      .get('/health')
      .set('Origin', 'https://untrusted.example')
      .expect(200);
    expect(untrusted.headers['access-control-allow-origin']).toBeUndefined();
  });
});
