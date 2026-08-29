import type { CreateProjectInput, Project } from '../domain/types.js';
import { type Clock, OrchestratorDatabase, systemClock } from './database.js';

export class ProjectRepository {
  public constructor(
    private readonly database: OrchestratorDatabase,
    private readonly clock: Clock = systemClock
  ) {}

  public list(): Project[] {
    return this.database.connection
      .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE, id')
      .all() as unknown as Project[];
  }

  public findById(id: number): Project | null {
    const row = this.database.connection
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id);
    return (row as unknown as Project | undefined) ?? null;
  }

  public findByRepositoryPath(repositoryPath: string): Project | null {
    const row = this.database.connection
      .prepare('SELECT * FROM projects WHERE repository_path = ?')
      .get(repositoryPath);
    return (row as unknown as Project | undefined) ?? null;
  }

  public create(input: Required<CreateProjectInput>): Project {
    const now = this.clock();
    const result = this.database.connection
      .prepare(`
        INSERT INTO projects (name, repository_path, context, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(input.name, input.repository_path, input.context, now, now);

    return this.findById(Number(result.lastInsertRowid)) as Project;
  }
}
