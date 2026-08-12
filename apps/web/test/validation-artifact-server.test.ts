import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectHash } from '@personal-agent/validation';
import { createWebServer } from '../src/server';

test('validation artifact API serves only safe run-scoped files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-validation-api-'));
  const configPath = join(directory, 'config.yaml');
  const artifacts = join(directory, 'artifacts');
  const project = projectHash(directory);
  const run = 'run-1';
  await mkdir(join(artifacts, project, run), { recursive: true });
  await writeFile(
    configPath,
    'memory:\n  enabled: false\nplugins:\n  enabled: false\nmcp:\n  servers: []\n',
  );
  await writeFile(
    join(directory, 'validation.yaml'),
    [
      'version: 1',
      'server:',
      '  url: http://127.0.0.1:3000',
      'artifacts:',
      `  root: ${JSON.stringify(artifacts)}`,
      'scenarios:',
      '  - name: home',
    ].join('\n'),
  );
  await writeFile(join(artifacts, project, run, 'report.json'), '{"safe":true}');
  const clientDirectory = join(directory, 'client');
  await mkdir(clientDirectory);
  await writeFile(join(clientDirectory, 'index.html'), '<h1>test</h1>');

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    clientBuildDirectory: clientDirectory,
    projectStoragePath: join(directory, 'projects.json'),
    validationConfigPath: join(directory, 'validation.yaml'),
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${instance.port}/api/validation/artifacts/${project}/${run}/report.json`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { safe: true });
    const traversal = await fetch(
      `http://127.0.0.1:${instance.port}/api/validation/artifacts/${project}/${run}/..%2Fconfig.yaml`,
    );
    assert.equal(traversal.status, 404);
  } finally {
    await instance.close();
  }
});
