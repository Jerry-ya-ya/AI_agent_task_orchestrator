import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { CreateProjectInput, Project } from '../domain/types.js';
import { ProjectRepository } from '../database/project-repository.js';
import { GitService } from './git-service.js';

export class ProjectService {
  public constructor(
    private readonly projects: ProjectRepository,
    private readonly git: GitService
  ) {}

  public list(): Project[] {
    return this.projects.list();
  }

  public get(id: number): Project {
    const project = this.projects.findById(id);
    if (project === null) {
      throw new NotFoundError(`Project ${id} was not found.`);
    }
    return project;
  }

  public async create(input: CreateProjectInput): Promise<Project> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new ValidationError('Project name is required.');
    }

    const repositoryPath = await this.git.validateRepository(input.repository_path.trim());
    if (this.projects.findByRepositoryPath(repositoryPath) !== null) {
      throw new ConflictError('That Git repository is already registered.');
    }

    try {
      return this.projects.create({
        name,
        repository_path: repositoryPath,
        context: input.context?.trim() ?? ''
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError('That Git repository is already registered.');
      }
      throw error;
    }
  }
}
