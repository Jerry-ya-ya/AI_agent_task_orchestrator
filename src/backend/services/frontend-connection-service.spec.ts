import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FrontendConnectionService } from './frontend-connection-service.js';

describe('FrontendConnectionService', () => {
  const temporaryPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  });

  it('stores local frontend targets in a JSON record and restores them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orchestrator-connections-'));
    temporaryPaths.push(root);
    const filePath = join(root, 'connections.json');
    const service = new FrontendConnectionService(filePath, () => '2026-09-26T00:00:00.000Z');

    const connection = await service.create({ name: 'Portal', url: 'http://localhost:5173/dashboard' });

    expect(connection).toMatchObject({ name: 'Portal', url: 'http://localhost:5173/dashboard' });
    await expect(service.list()).resolves.toEqual([connection]);
    await expect(readFile(filePath, 'utf8')).resolves.toContain('"connections"');
  });

  it('accepts only loopback HTTP(S) targets and removes saved records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orchestrator-connections-'));
    temporaryPaths.push(root);
    const service = new FrontendConnectionService(join(root, 'connections.json'));
    const connection = await service.create({ name: 'Local', url: 'https://127.0.0.1:8443' });

    await expect(service.create({ name: 'Remote', url: 'https://example.com' }))
      .rejects.toThrow('Only localhost, 127.0.0.1, or ::1 HTTP(S) frontends can be connected.');
    await expect(service.remove(connection.id)).resolves.toBe(true);
    await expect(service.list()).resolves.toEqual([]);
  });

  it('updates a saved connection without changing its identity or creation time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orchestrator-connections-'));
    temporaryPaths.push(root);
    const service = new FrontendConnectionService(join(root, 'connections.json'), () => '2026-09-27T00:00:00.000Z');
    const connection = await service.create({ name: 'Portal', url: 'http://localhost:4100' });

    const updated = await service.update(connection.id, { name: 'Admin portal', url: 'http://127.0.0.1:4200/' });

    expect(updated).toMatchObject({ id: connection.id, name: 'Admin portal', url: 'http://127.0.0.1:4200/' });
    expect(updated.created_at).toBe(connection.created_at);
    await expect(service.list()).resolves.toEqual([updated]);
  });
});
