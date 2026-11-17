// The lifecycle the harness drives: bind an ephemeral port, register it
// with the env, poll the env's /done until the suite finishes, exit 0.
// With MAKEFUN_ENV_URL unset there is nothing to talk to, so the forge
// serves on PORT (default 3000) for local testing instead.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { Forge } from './forge/store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'local-test-token';
const ENV_URL = process.env.MAKEFUN_ENV_URL;
const PORT = Number(process.env.PORT ?? '3000');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<void> {
  let delay = 250;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      // 200 registers; 409 means an earlier register already won (a retry
      // after a success the client did not see) — the base URL is set either way.
      if (response.ok || response.status === 409) return;
      throw new Error(`register answered HTTP ${response.status}`);
    } catch (err) {
      if (attempt === 11) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
}

async function waitDone(envUrl: string): Promise<void> {
  for (;;) {
    await sleep(1000);
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const body = (await response.json()) as { done?: unknown };
      if (body.done === true) return;
    } catch {
      // A failed poll is retried, not fatal.
    }
  }
}

async function main(): Promise<void> {
  const forge = new Forge(TOKEN);
  const server = createApp(forge);
  if (ENV_URL) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    await register(ENV_URL, port);
    await waitDone(ENV_URL);
    server.close();
    process.exit(0);
  }
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`github-core-clone listening on http://127.0.0.1:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
