import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { AppError } from '../domain/errors.js';
import { TASK_PRIORITIES, TASK_STATUSES, type WorkerStatus } from '../domain/types.js';
import { ProjectService } from '../services/project-service.js';
import { TaskService } from '../services/task-service.js';

export interface ApiDependencies {
  projectService: ProjectService;
  taskService: TaskService;
  workerStatus: () => WorkerStatus;
}

const idSchema = z.coerce.number().int().positive();
const projectInput = z.object({
  name: z.string().min(1).max(200),
  repository_path: z.string().min(1).max(4_096),
  context: z.string().max(50_000).optional()
}).strict();
const taskInput = z.object({
  project_id: z.number().int().positive(),
  title: z.string().min(1).max(500),
  description: z.string().max(100_000).optional(),
  priority: z.enum(TASK_PRIORITIES).optional()
}).strict();
const taskUpdate = z.object({
  project_id: z.number().int().positive().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(100_000).optional(),
  priority: z.enum(TASK_PRIORITIES).optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required.');

export function createApi(dependencies: ApiDependencies): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (
      origin === 'null' ||
      origin === 'http://127.0.0.1:4200' ||
      origin === 'http://localhost:4200'
    ) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/health', (_request, response) => {
    response.json({ ok: true, worker: dependencies.workerStatus() });
  });

  app.get('/projects', (_request, response) => {
    response.json(dependencies.projectService.list());
  });

  app.post('/projects', async (request, response) => {
    const created = await dependencies.projectService.create(projectInput.parse(request.body));
    response.status(201).json(created);
  });

  app.get('/tasks', (request, response) => {
    const query = z.object({
      project_id: idSchema.optional(),
      status: z.enum(TASK_STATUSES).optional()
    }).parse(request.query);
    response.json(dependencies.taskService.list({
      projectId: query.project_id,
      status: query.status
    }));
  });

  app.get('/tasks/:id', (request, response) => {
    response.json(dependencies.taskService.get(idSchema.parse(request.params.id)));
  });

  app.post('/tasks', (request, response) => {
    response.status(201).json(dependencies.taskService.create(taskInput.parse(request.body)));
  });

  app.put('/tasks/:id', (request, response) => {
    response.json(dependencies.taskService.update(
      idSchema.parse(request.params.id),
      taskUpdate.parse(request.body)
    ));
  });

  app.delete('/tasks/:id', (request, response) => {
    dependencies.taskService.delete(idSchema.parse(request.params.id));
    response.sendStatus(204);
  });

  app.post('/tasks/:id/retry', (request, response) => {
    response.json(dependencies.taskService.retry(idSchema.parse(request.params.id)));
  });

  app.post('/tasks/:id/approve', (request, response) => {
    response.json(dependencies.taskService.approve(idSchema.parse(request.params.id)));
  });

  app.get('/tasks/:id/runs', (request, response) => {
    response.json(dependencies.taskService.runsForTask(idSchema.parse(request.params.id)));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'The request is invalid.',
        details: z.treeifyError(error)
      });
      return;
    }
    if (error instanceof AppError) {
      response.status(error.statusCode).json({ error: error.code, message: error.message });
      return;
    }
    console.error('[api] Unhandled error:', error);
    response.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected server error.' });
  });

  return app;
}
