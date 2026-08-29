import type {
  AgentAvailability,
  AgentExecutionResult,
  Project,
  Task
} from '../domain/types.js';

export type AgentTask = Task & { project?: Project };

/** Boundary that keeps the worker independent of any particular coding agent CLI. */
export interface AgentExecutor {
  checkAvailability(): Promise<AgentAvailability>;
  execute(
    task: AgentTask,
    workspace: string,
    signal?: AbortSignal
  ): Promise<AgentExecutionResult>;
}
