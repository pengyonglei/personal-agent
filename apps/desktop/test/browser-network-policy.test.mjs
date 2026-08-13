import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

test('embedded browser network policy permits local WebSockets only', async () => {
  const sourcePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'browser-network-policy.ts',
  );
  const source = await readFile(sourcePath, 'utf8');
  const transformed = await transform(source, { loader: 'ts', format: 'esm' });
  const policy = await import(
    `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`
  );

  assert.equal(policy.isAllowedLocalResource('http://127.0.0.1:5681/app.js'), true);
  assert.equal(policy.isAllowedLocalResource('ws://127.0.0.1:5681/ws'), true);
  assert.equal(policy.isAllowedLocalResource('wss://localhost:5681/ws'), true);
  assert.equal(policy.isAllowedLocalResource('blob:http://127.0.0.1:5681/id'), true);
  assert.equal(policy.isAllowedLocalResource('ws://example.com/ws'), false);
  assert.equal(policy.isAllowedLocalResource('https://example.com/app.js'), false);
  assert.equal(policy.isAllowedLocalResource('file:///C:/secret.txt'), false);

  assert.equal(policy.isAllowedLocalNavigation('http://localhost:5681/'), true);
  assert.equal(policy.isAllowedLocalNavigation('https://example.com/'), false);
});
