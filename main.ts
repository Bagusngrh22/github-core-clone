// main.ts — the forge's front door.
//
// This module owns nothing but the process lifecycle: it builds the HTTP
// server from app.ts, lets the kernel pick a free port, hands that port to
// the trial harness, and then idles until the harness reports the trial is
// finished, at which point the process leaves with a clean exit code.
//
// The forge itself — git smart HTTP, REST v3, GraphQL and MCP — lives in
// app.ts and friends. Nothing below inspects a repository or an object.

import { createApp } from './app.ts';

// How long to rest between two "are we done yet?" questions, in
// milliseconds. Short enough that shutdown stays prompt, long enough that
// the harness is not hammered while a trial runs.
const POLL_GAP_MS = 500;

// How many times the registration call is retried before giving up, and
// how long to wait between attempts. The harness may still be warming up
// when this process starts, so a single attempt would be brittle.
const ANNOUNCE_TRIES = 30;
const ANNOUNCE_GAP_MS = 1000;

// Which port to ask for. Zero means "let the kernel choose", which is
// what the harness expects; an explicit MAKEFUN_PORT or PORT in the
// environment wins over that when one is set.
function desiredPort(): number {
  const raw = process.env.MAKEFUN_PORT ?? process.env.PORT ?? '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

// The harness origin, without a trailing slash so joins stay tidy.
function harnessOrigin(): string {
  const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (origin === '') {
    throw new Error('MAKEFUN_ENV_URL is not set; cannot register with the harness');
  }
  return origin;
}

function nap(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Tell the harness which port the forge listens on. Retried because the
// harness side may not be accepting registrations yet at boot.
async function announcePort(port: number): Promise<void> {
  const target = `${harnessOrigin()}/register`;
  let lastFailure: unknown = null;
  for (let attempt = 1; attempt <= ANNOUNCE_TRIES; attempt += 1) {
    try {
      const reply = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (reply.ok) return;
      lastFailure = new Error(`register answered HTTP ${reply.status}`);
    } catch (err) {
      lastFailure = err;
    }
    if (attempt < ANNOUNCE_TRIES) await nap(ANNOUNCE_GAP_MS);
  }
  throw lastFailure instanceof Error ? lastFailure : new Error('register failed');
}

// One "are we done yet?" question. A lost connection or a garbled reply
// is treated as "not yet" — only an explicit done:true ends the wait.
async function trialFinished(): Promise<boolean> {
  try {
    const reply = await fetch(`${harnessOrigin()}/done`);
    if (!reply.ok) return false;
    const payload = (await reply.json()) as unknown;
    return (
      payload !== null &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>)['done'] === true
    );
  } catch {
    return false;
  }
}

// Keep asking until the harness says the trial is over.
async function waitForHarness(): Promise<void> {
  for (;;) {
    if (await trialFinished()) return;
    await nap(POLL_GAP_MS);
  }
}

async function boot(): Promise<void> {
  const forge = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(desiredPort(), '0.0.0.0', () => {
      const address = forge.address();
      if (address !== null && typeof address === 'object') resolve(address.port);
      else reject(new Error('server started without a usable address'));
    });
  });
  console.log(`forge listening on port ${port}`);
  await announcePort(port);
  console.log('forge registered with the harness');
  await waitForHarness();
  await new Promise<void>((resolve) => {
    forge.close(() => resolve());
  });
}

boot()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
