import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { normalizeValidationConfig } from '../src/config';
import { ensureValidationServer, isReachable, ValidationInfrastructureError } from '../src/server';

test('reuses a healthy server without owning its lifecycle', async (context) => {
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const managed = await ensureValidationServer(
    normalizeValidationConfig({ server: { url }, scenarios: [{ name: 'home' }] }),
    process.cwd(),
  );
  assert.equal(managed.reused, true);
  await managed.stop();
  assert.equal(await isReachable(url), true);
});

test(
  'starts a server, waits for health, and cleans up its process tree',
  { timeout: 20_000 },
  async () => {
    const probe = createServer();
    await new Promise<void>((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
    const address = probe.address();
    assert.ok(address && typeof address === 'object');
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
    const url = `http://127.0.0.1:${address.port}`;
    const fixture = resolve(import.meta.dirname, 'fixtures/server.mjs');
    const managed = await ensureValidationServer(
      normalizeValidationConfig({
        server: { url, command: `node "${fixture}" ${address.port}`, timeoutMs: 8_000 },
        scenarios: [{ name: 'home' }],
      }),
      process.cwd(),
    );
    assert.equal(managed.reused, false);
    assert.equal(await isReachable(url), true);
    await managed.stop();
    assert.equal(await isReachable(url), false);
  },
);

test('reports startup timeout as an infrastructure error', { timeout: 10_000 }, async () => {
  const config = normalizeValidationConfig({
    server: {
      url: 'http://127.0.0.1:61999',
      command: 'node -e "setTimeout(() => {}, 10000)"',
      timeoutMs: 300,
      reuseExisting: false,
    },
    scenarios: [{ name: 'home' }],
  });
  await assert.rejects(
    () => ensureValidationServer(config, process.cwd()),
    (error: unknown) =>
      error instanceof ValidationInfrastructureError &&
      error.message.includes('did not become healthy'),
  );
});
