import assert from 'node:assert/strict';
import test from 'node:test';
import { withBrowserTimeout } from '../src/tools/browser';

test('browser operations reject at their deadline instead of remaining pending', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    withBrowserTimeout(new Promise<never>(() => undefined), 25, 'browser deadline reached'),
    /browser deadline reached/,
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test('browser operation timeout preserves a prompt successful result', async () => {
  assert.equal(await withBrowserTimeout(Promise.resolve('ready'), 1_000, 'too slow'), 'ready');
});
