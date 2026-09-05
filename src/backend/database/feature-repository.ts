import type { CreateFeatureInput, Feature } from '../domain/types.js';
import { type Clock, OrchestratorDatabase, systemClock } from './database.js';

export class FeatureRepository {
  public constructor(
    private readonly database: OrchestratorDatabase,
    private readonly clock: Clock = systemClock,
  ) {}

  public list(projectId?: number): Feature[] {
    if (projectId === undefined) {
      return this.database.connection.prepare(
        'SELECT * FROM features ORDER BY project_id, created_at, id',
      ).all() as unknown as Feature[];
    }
    return this.database.connection.prepare(
      'SELECT * FROM features WHERE project_id = ? ORDER BY created_at, id',
    ).all(projectId) as unknown as Feature[];
  }

  public findById(id: number): Feature | null {
    const row = this.database.connection.prepare('SELECT * FROM features WHERE id = ?').get(id);
    return (row as unknown as Feature | undefined) ?? null;
  }

  public create(input: CreateFeatureInput, branchName: string, baseBranch: string): Feature {
    const now = this.clock();
    const result = this.database.connection.prepare(`
      INSERT INTO features (project_id, name, branch_name, base_branch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.project_id, input.name, branchName, baseBranch, now, now);
    return this.findById(Number(result.lastInsertRowid)) as Feature;
  }
}
