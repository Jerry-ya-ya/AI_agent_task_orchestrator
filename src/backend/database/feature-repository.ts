import type { CreateFeatureInput, Feature } from '../domain/types.js';
import { ConflictError } from '../domain/errors.js';
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
    try {
      const result = this.database.connection.prepare(`
        INSERT INTO features (project_id, name, branch_name, base_branch, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.project_id, input.name, branchName, baseBranch, now, now);
      return this.findById(Number(result.lastInsertRowid)) as Feature;
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError('A Feature with the same name or branch already exists in this project.');
      }
      throw error;
    }
  }

  public branchOrder(projectId: number): Map<string, number> {
    const rows = this.database.connection.prepare(`
      SELECT branch_name, position FROM branch_display_order
      WHERE project_id = ? ORDER BY position
    `).all(projectId) as Array<{ branch_name: string; position: number }>;
    return new Map(rows.map((row) => [row.branch_name, row.position]));
  }

  public saveBranchOrder(projectId: number, branchNames: readonly string[]): void {
    this.database.transaction(() => {
      this.database.connection.prepare('DELETE FROM branch_display_order WHERE project_id = ?').run(projectId);
      const insert = this.database.connection.prepare(`
        INSERT INTO branch_display_order (project_id, branch_name, position) VALUES (?, ?, ?)
      `);
      branchNames.forEach((name, position) => insert.run(projectId, name, position));
    });
  }
}
