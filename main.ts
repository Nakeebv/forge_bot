// The entry <-> env lifecycle, as env/src/wire.ts settles it: bind an ephemeral port, tell the env the
// port it bound, then poll until the env says the trial is over and exit 0. Keep this file as it is:
// the suite scores the server app.ts builds, and the lifecycle is the harness's, not the contest's.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial container). Without it
//      there is nothing to talk to, so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came from
//      plus N as your base URL and dials it from then on. The first register wins; a 409 means another
//      entry already registered, and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once ({"done":
//      false} while the suite runs), so this is a poll, not a long-held request. A failed or slow poll
//      is retried with backoff; a done that never comes is cut off by the hard deadline.
//   5. done:true -> close the server and exit 0. The env reads the graded state on its own schedule
//      around the done window, so the process stays up the whole time.

import { createServer } from 'node:http';
import { createApp } from './app.ts';

const POLL_MS = 500;
const POLL_BACKOFF_CAP_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;

function envOrigin(): string | null {
  const raw = process.env['MAKEFUN_ENV_URL'];
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response.status;
}

async function pollDone(url: string, deadline: number): Promise<void> {
  let backoffMs = POLL_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { done?: unknown } | null;
        if (body?.done === true) return;
        backoffMs = POLL_MS;
      } else {
        await response.body?.cancel();
        backoffMs = Math.min(backoffMs * 2, POLL_BACKOFF_CAP_MS);
      }
    } catch {
      backoffMs = Math.min(backoffMs * 2, POLL_BACKOFF_CAP_MS);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(backoffMs, remaining)));
  }
}

const origin = envOrigin();
if (!origin) {
  console.error('MAKEFUN_ENV_URL is missing or not a valid URL');
  process.exit(1);
}

const server = createServer(createApp());

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '0.0.0.0', () => {
    server.off('error', reject);
    resolve();
  });
});

const address = server.address();
if (!address || typeof address === 'string') {
  console.error('server is not listening on a TCP port');
  process.exit(1);
}
const port = address.port;
console.log(`listening on http://0.0.0.0:${port}`);

const deadline = Date.now() + 60 * 60_000;
await postJson(`${origin}/register`, { port });
await pollDone(`${origin}/done`, deadline);

await new Promise<void>((resolve) => server.close(() => resolve()));
process.exit(0);