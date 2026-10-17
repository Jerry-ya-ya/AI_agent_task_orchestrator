import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WorklogService } from './worklog-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('WorklogService', () => {
  it('reads the configured worklog and treats a missing file as empty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orchestrator-worklog-'));
    temporaryDirectories.push(directory);
    const worklogPath = join(directory, 'worklog.md');
    const service = new WorklogService(worklogPath);

    await expect(service.read()).resolves.toEqual({ content: '' });
    await writeFile(worklogPath, '# Worklog\n\n- update\n', 'utf8');
    await expect(service.read()).resolves.toEqual({ content: '# Worklog\n\n- update\n' });
  });
});
