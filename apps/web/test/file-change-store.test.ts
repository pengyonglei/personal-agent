import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StoredFileChangeBatch } from '../src/protocol';
import { FileChangeStore, MAX_STORED_DIFF_LINES, isTemporaryFilePath } from '../src/file-change-store';
import { createWebServer } from '../src/server';

function createBatch(id: string, time: string, fileCount = 1): StoredFileChangeBatch {
  return {
    id,
    taskId: 'task-1',
    time,
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `src/file-${index}.ts`,
      oldContent: `old-${index}`,
      newContent: `new-${index}`,
    })),
  };
}

test('FileChangeStore saves and lists batches round-trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-file-changes-roundtrip-'));
  const store = new FileChangeStore(directory);

  await store.save(createBatch('fc-1', '2026-08-08T10:00:00.000Z'));
  await store.save(
    createBatch('fc-2', '2026-08-08T11:00:00.000Z', 2),
  );

  const batches = await store.list();
  assert.equal(batches.length, 2);
  // 按 time 降序
  assert.equal(batches[0]?.id, 'fc-2');
  assert.equal(batches[1]?.id, 'fc-1');
  assert.equal(batches[0]?.taskId, 'task-1');
  assert.equal(batches[0]?.files.length, 2);
  assert.equal(batches[1]?.files[0]?.oldContent, 'old-0');
  assert.equal(batches[1]?.files[0]?.newContent, 'new-0');
});

test('FileChangeStore skips corrupt or invalid files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-file-changes-invalid-'));
  const store = new FileChangeStore(directory);
  await store.save(createBatch('fc-ok', '2026-08-08T10:00:00.000Z'));

  await writeFile(join(directory, 'broken.json'), 'not-json{', 'utf-8');
  await writeFile(
    join(directory, 'missing-fields.json'),
    JSON.stringify({ id: 'no-files' }),
    'utf-8',
  );
  await writeFile(join(directory, 'ignored.txt'), 'ignored', 'utf-8');

  const batches = await store.list();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.id, 'fc-ok');
});

test('FileChangeStore sanitizes batch ids for file names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-file-changes-sanitize-'));
  const store = new FileChangeStore(directory);

  await store.save(createBatch('fc a/b?c', '2026-08-08T10:00:00.000Z'));

  const files = await readdir(directory);
  assert.ok(files.some((file) => file === 'fc_a_b_c.json'), `files: ${files.join(', ')}`);
  const batches = await store.list();
  assert.equal(batches[0]?.id, 'fc a/b?c');
});

test('FileChangeStore caps the number of stored batches by mtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-file-changes-cap-'));
  const store = new FileChangeStore(directory);

  for (let index = 0; index < 205; index += 1) {
    await store.save(createBatch(`fc-cap-${index}`, `2026-08-08T${String(index).padStart(2, '0')}:00:00.000Z`));
  }

  const batches = await store.list();
  assert.equal(batches.length, 200);
  // 最旧的 5 份被删除（按 mtime，最早的先删）
  assert.equal(batches.some((batch) => batch.id === 'fc-cap-0'), false);
  assert.equal(batches.some((batch) => batch.id === 'fc-cap-204'), true);
});

test('FileChangeStore truncates oversized contents and marks the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-file-changes-truncate-'));
  const store = new FileChangeStore(directory);

  const bigOld = Array.from({ length: MAX_STORED_DIFF_LINES + 10 }, (_, i) => `old-${i}`).join('\n');
  const batch = createBatch('fc-big', '2026-08-08T10:00:00.000Z');
  batch.files = [{ path: 'big.txt', oldContent: bigOld, newContent: 'new' }];
  await store.save(batch);

  const [stored] = await store.list();
  assert.ok(stored);
  assert.equal(stored.files[0]?.truncated, true);
  // 旧内容只保留前 MAX_STORED_DIFF_LINES 行，新内容短不截断
  assert.equal(stored.files[0]?.oldContent.split('\n').length, MAX_STORED_DIFF_LINES);
  assert.equal(stored.files[0]?.newContent, 'new');
});

test('FileChangeStore delete removes a batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-file-changes-delete-'));
  const store = new FileChangeStore(directory);
  await store.save(createBatch('fc-del', '2026-08-08T10:00:00.000Z'));

  assert.equal(await store.delete('fc-del'), true);
  assert.equal(await store.delete('fc-del'), false); // 已删除
  assert.equal((await store.list()).length, 0);
});

test('isTemporaryFilePath identifies one-off temporary files', () => {
  assert.equal(isTemporaryFilePath('.tmp-e2e.mjs'), true);
  assert.equal(isTemporaryFilePath('D:/repo/.tmp-skill-edit.ps1'), true);
  assert.equal(isTemporaryFilePath('D:\\repo\\.tmp-test-out.txt'), true);
  assert.equal(isTemporaryFilePath('tmp-check.mjs'), true);
  assert.equal(isTemporaryFilePath('foo.tmp'), true);
  assert.equal(isTemporaryFilePath('foo.ts~'), true);
  assert.equal(isTemporaryFilePath('.tmp-shell-verify/out.txt'), true);
  assert.equal(isTemporaryFilePath('src/App.tsx'), false);
  assert.equal(isTemporaryFilePath('README.md'), false);
  assert.equal(isTemporaryFilePath('packages/plugin/src/index.ts'), false);
});

test('FileChangeStore excludes temporary files from saved and listed batches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-file-changes-tmp-'));
  const store = new FileChangeStore(directory);

  const batch = createBatch('fc-tmp', '2026-08-08T10:00:00.000Z');
  batch.files = [
    { path: 'src/real.ts', oldContent: 'a', newContent: 'b' },
    { path: '.tmp-e2e.mjs', oldContent: '', newContent: 'console.log(1)' },
    { path: 'scripts/tmp-check.txt', oldContent: '', newContent: 'x' },
    { path: 'notes/readme.md~', oldContent: '', newContent: 'x' },
  ];
  await store.save(batch);

  const [stored] = await store.list();
  assert.ok(stored);
  assert.deepEqual(
    stored.files.map((file) => file.path),
    ['src/real.ts'],
  );

  // 全部为临时文件的批次：不落盘、不展示
  const onlyTmp = createBatch('fc-only-tmp', '2026-08-08T11:00:00.000Z');
  onlyTmp.files = [{ path: '.tmp-debug.mjs', oldContent: '', newContent: 'x' }];
  await store.save(onlyTmp);
  const batches = await store.list();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.id, 'fc-tmp');
});

test('GET /api/file-changes returns persisted batches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-file-changes-'));
  const fileChangesDirectory = join(directory, 'file-changes');
  await mkdir(fileChangesDirectory);
  const configPath = join(directory, 'config.yaml');
  await writeFile(
    configPath,
    ['memory:', '  enabled: false', 'plugins:', '  enabled: false', 'mcp:', '  servers: []'].join(
      '\n',
    ),
    'utf-8',
  );
  const clientBuildDirectory = join(directory, 'client');
  await mkdir(clientBuildDirectory);
  await writeFile(join(clientBuildDirectory, 'index.html'), '<h1>desktop client</h1>', 'utf8');

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
    clientBuildDirectory,
    fileChangesDirectory,
  });

  try {
    // 初始为空
    const emptyResponse = await fetch(`http://127.0.0.1:${instance.port}/api/file-changes`);
    assert.equal(emptyResponse.status, 200);
    const empty = (await emptyResponse.json()) as { batches: StoredFileChangeBatch[] };
    assert.deepEqual(empty.batches, []);

    // 手工写入一份批次（等价于 emitRunChanges 落盘）
    const batch = createBatch('fc-api-1', '2026-08-08T10:00:00.000Z');
    await writeFile(join(fileChangesDirectory, 'fc-api-1.json'), JSON.stringify(batch), 'utf-8');

    const response = await fetch(`http://127.0.0.1:${instance.port}/api/file-changes`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { batches: StoredFileChangeBatch[] };
    assert.equal(payload.batches.length, 1);
    assert.equal(payload.batches[0]?.id, 'fc-api-1');
    assert.equal(payload.batches[0]?.files[0]?.path, 'src/file-0.ts');

    // DELETE 删除批次
    const deleteResponse = await fetch(`http://127.0.0.1:${instance.port}/api/file-changes/fc-api-1`, {
      method: 'DELETE',
    });
    assert.equal(deleteResponse.status, 200);
    const deleted = (await deleteResponse.json()) as { deleted: boolean };
    assert.equal(deleted.deleted, true);
    const after = await fetch(`http://127.0.0.1:${instance.port}/api/file-changes`);
    assert.equal(((await after.json()) as { batches: StoredFileChangeBatch[] }).batches.length, 0);
  } finally {
    await instance.close();
  }
});
