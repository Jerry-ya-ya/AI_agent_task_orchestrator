import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { CreateFrontendConnectionInput, FrontendConnection } from '../domain/types.js';

interface ConnectionStore {
  version: 1;
  connections: FrontendConnection[];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Persists trusted local frontend targets separately from the task database. */
export class FrontendConnectionService {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async list(): Promise<FrontendConnection[]> {
    const store = await this.readStore();
    return store.connections.map((connection) => ({ ...connection }));
  }

  public async create(input: CreateFrontendConnectionInput): Promise<FrontendConnection> {
    const { name, url } = normalizeConnectionInput(input);
    return await this.enqueueWrite(async () => {
      const store = await this.readStore();
      if (store.connections.some((connection) => connection.url === url)) {
        throw new ConflictError('That local frontend URL is already connected.');
      }
      const timestamp = this.now();
      const connection: FrontendConnection = {
        id: randomUUID(), name, url, created_at: timestamp, updated_at: timestamp,
      };
      store.connections.push(connection);
      await this.writeStore(store);
      return connection;
    });
  }

  public async update(id: string, input: CreateFrontendConnectionInput): Promise<FrontendConnection> {
    const { name, url } = normalizeConnectionInput(input);
    return await this.enqueueWrite(async () => {
      const store = await this.readStore();
      const existing = store.connections.find((connection) => connection.id === id);
      if (existing === undefined) throw new NotFoundError('Frontend connection not found.');
      if (store.connections.some((connection) => connection.id !== id && connection.url === url)) {
        throw new ConflictError('That local frontend URL is already connected.');
      }
      const updated: FrontendConnection = {
        ...existing,
        name,
        url,
        updated_at: this.now(),
      };
      store.connections = store.connections.map((connection) => connection.id === id ? updated : connection);
      await this.writeStore(store);
      return updated;
    });
  }

  public async remove(id: string): Promise<boolean> {
    return await this.enqueueWrite(async () => {
      const store = await this.readStore();
      const next = store.connections.filter((connection) => connection.id !== id);
      if (next.length === store.connections.length) return false;
      store.connections = next;
      await this.writeStore(store);
      return true;
    });
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    let release: () => void = () => undefined;
    const previous = this.writeQueue;
    this.writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readStore(): Promise<ConnectionStore> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as Partial<ConnectionStore>;
      if (parsed.version !== 1 || !Array.isArray(parsed.connections)) {
        throw new ValidationError('The frontend connections file has an unsupported format.');
      }
      return {
        version: 1,
        connections: parsed.connections.filter(isStoredConnection),
      };
    } catch (error: unknown) {
      if (isMissingFileError(error)) return { version: 1, connections: [] };
      if (error instanceof ValidationError) throw error;
      throw new ValidationError('The frontend connections file could not be read.');
    }
  }

  private async writeStore(store: ConnectionStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = join(dirname(this.filePath), `.${randomUUID()}.connections.json`);
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}

function normalizeConnectionInput(input: CreateFrontendConnectionInput): Pick<FrontendConnection, 'name' | 'url'> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 120) {
    throw new ValidationError('Connection name must be between 1 and 120 characters.');
  }
  return { name, url: normalizeLoopbackUrl(input.url) };
}

function normalizeLoopbackUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ValidationError('Connection URL must be a valid local HTTP(S) URL.');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || !LOOPBACK_HOSTS.has(parsed.hostname.toLocaleLowerCase())
    || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ValidationError('Only localhost, 127.0.0.1, or ::1 HTTP(S) frontends can be connected.');
  }
  return parsed.toString();
}

function isStoredConnection(value: unknown): value is FrontendConnection {
  if (typeof value !== 'object' || value === null) return false;
  const connection = value as Record<string, unknown>;
  return typeof connection['id'] === 'string'
    && typeof connection['name'] === 'string'
    && typeof connection['url'] === 'string'
    && isLoopbackHttpUrl(connection['url'])
    && typeof connection['created_at'] === 'string'
    && typeof connection['updated_at'] === 'string';
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && LOOPBACK_HOSTS.has(url.hostname.toLocaleLowerCase())
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
