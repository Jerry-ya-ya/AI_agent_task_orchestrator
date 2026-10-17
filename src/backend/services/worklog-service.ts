import { readFile } from 'node:fs/promises';

export class WorklogService {
  public constructor(private readonly worklogPath: string) {}

  public async read(): Promise<{ content: string }> {
    try {
      return { content: await readFile(this.worklogPath, 'utf8') };
    } catch (error) {
      if (isMissingFile(error)) return { content: '' };
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
