// The HTTP server: routing, body reading, auth, and response framing.
// Everything in-memory; a handler error is a 500, never a crash.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphql } from './forge/graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './forge/gitproto.ts';
import { handleMcp } from './forge/mcp.ts';
import { handleRest } from './forge/rest.ts';
import { Forge } from './forge/store.ts';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    ...extraHeaders,
  });
  res.end(data);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...extraHeaders });
  res.end(body);
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    const path = url.pathname;

    // The boot probe takes no auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Every other surface needs the shop token. The 401 carries the same
    // request id GitHub's API replies carry.
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${forge.token}`) {
      sendJson(res, 401, { message: 'Unauthorized' }, { 'X-GitHub-Request-Id': forge.nextRequestId() });
      return;
    }

    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const body = needsBody ? await readBody(req) : null;
    const host = req.headers.host ?? '127.0.0.1';
    const baseUrl = `http://${host}`;

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const service = gitMatch[3];
      if (owner !== forge.viewerLogin) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const repo = forge.getRepo(repoName);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (service === 'info/refs') {
        const serviceParam = url.searchParams.get('service');
        if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'service is required' });
          return;
        }
        const version = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
        const out = handleInfoRefs(forge, repo, serviceParam, version);
        sendBuffer(res, out.status, out.body, out.contentType);
        return;
      }
      if (service === 'git-upload-pack' && method === 'POST') {
        const version = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
        const out = handleUploadPack(forge, repo, body ?? Buffer.alloc(0), version);
        sendBuffer(res, out.status, out.body, out.contentType);
        return;
      }
      if (service === 'git-receive-pack' && method === 'POST') {
        const out = handleReceivePack(forge, repo, body ?? Buffer.alloc(0));
        sendBuffer(res, out.status, out.body, out.contentType);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // GraphQL.
    if (method === 'POST' && path === '/api/graphql') {
      const out = handleGraphql(forge, body ?? Buffer.alloc(0));
      sendJson(res, out.status, out.json);
      return;
    }

    // MCP.
    if (method === 'POST' && path === '/mcp') {
      const out = handleMcp(forge, body ?? Buffer.alloc(0));
      if (out.empty) {
        res.writeHead(out.status);
        res.end();
        return;
      }
      sendJson(res, out.status, out.json);
      return;
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
      const segments = restPath === '' ? [] : restPath.split('/').map((s) => decodeURIComponent(s));
      const out = handleRest(forge, { method, segments, query: url.searchParams, body, baseUrl });
      const headers: Record<string, string> = {
        'X-GitHub-Request-Id': forge.nextRequestId(),
        'X-OAuth-Scopes': 'repo, read:org',
        ...out.headers,
      };
      if (out.status === 204) {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      sendJson(res, out.status, out.json ?? { message: 'Not Found' }, headers);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, { 'X-GitHub-Request-Id': forge.nextRequestId() });
  } catch (e) {
    console.error('request failed:', e instanceof Error ? e.message : e);
    if (!res.headersSent) sendJson(res, 500, { message: 'internal error' });
    else res.end();
  }
}

export function createApp(forge: Forge): Server {
  return createServer((req, res) => {
    void handleRequest(forge, req, res);
  });
}
