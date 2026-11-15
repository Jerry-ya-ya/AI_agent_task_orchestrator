import { readFile } from 'node:fs/promises';
import { createServer, request as forward, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const port = 4317;
const supportedOrigins = new Set(['http://127.0.0.1:4300', 'http://localhost:4300']);
const supportedHosts = new Set(['127.0.0.1:4317', 'localhost:4317']);
const supportedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const appId = 'dev.local.ai-agent-task-orchestrator';

function desktopHome(): string {
  const override = process.env['ORCHESTRATOR_DESKTOP_DATA_DIR'];
  if (override) return override;

  const dataRoot = process.platform === 'win32'
    ? process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share');
  return join(dataRoot, appId);
}

async function readConnection(): Promise<{ baseUrl: string; token: string }> {
  const record: unknown = JSON.parse(
    await readFile(join(desktopHome(), 'data', 'browser-connection.json'), 'utf8'),
  );
  if (
    typeof record !== 'object' || record === null ||
    !('baseUrl' in record) || typeof record.baseUrl !== 'string' ||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(record.baseUrl) ||
    Number(new URL(record.baseUrl).port) === port ||
    !('token' in record) || typeof record.token !== 'string' || !/^[a-f0-9]{64}$/.test(record.token)
  ) {
    throw new Error('Invalid desktop backend connection.');
  }
  return { baseUrl: record.baseUrl, token: record.token };
}

function unavailable(response: ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    error: 'Open or restart the Rust desktop app to connect to its database.',
  }));
}

const server = createServer(async (incoming, outgoing) => {
  const { origin, host } = incoming.headers;
  // Only the local Angular development origins can use the desktop credential.
  if (!host || !supportedHosts.has(host) || !origin || !supportedOrigins.has(origin)) {
    outgoing.writeHead(403).end();
    return;
  }
  outgoing.setHeader('Access-Control-Allow-Origin', origin);
  outgoing.setHeader('Vary', 'Origin');
  outgoing.setHeader('Access-Control-Expose-Headers', 'X-Orchestrator-Shared-Desktop');
  outgoing.setHeader('X-Orchestrator-Shared-Desktop', '1');
  outgoing.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  outgoing.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');

  if (incoming.method === 'OPTIONS') {
    outgoing.writeHead(204).end();
    return;
  }
  if (!incoming.method || !supportedMethods.has(incoming.method) || !incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
    outgoing.writeHead(400).end();
    return;
  }

  try {
    const { baseUrl, token } = await readConnection();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    for (const name of ['content-type', 'content-length'] as const) {
      const value = incoming.headers[name];
      if (value !== undefined) headers[name] = value;
    }

    const upstream = forward(baseUrl, { method: incoming.method, path: incoming.url, headers }, (response) => {
      const contentType = response.headers['content-type'];
      if (contentType) outgoing.setHeader('Content-Type', contentType);
      outgoing.writeHead(response.statusCode ?? 502);
      response.on('error', () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstream.on('error', () => unavailable(outgoing));
    upstream.setTimeout(60_000, () => upstream.destroy());
    outgoing.once('close', () => upstream.destroy());
    incoming.on('error', () => upstream.destroy());
    incoming.pipe(upstream);
  } catch {
    unavailable(outgoing);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[orchestrator] Browser bridge listening at http://127.0.0.1:${port}`);
});
