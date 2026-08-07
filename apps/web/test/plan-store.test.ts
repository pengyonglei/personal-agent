import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PlanDoc } from '../src/plan-doc';
import { PlanStore } from '../src/plan-store';
import { createWebServer } from '../src/server';

function createPlanDoc(id: string, title: string, updatedAt: number): PlanDoc {
  return {
    id,
    taskId: 'task-1',
    title,
    markdown: `# ${title}\n\n## 执行步骤\n\n1. 步骤一`,
    plan: {
      id,
      title,
      description: '',
      status: 'draft',
      steps: [
        {
          id: 'step-1',
          order: 1,
          title: '步骤一',
          description: '步骤一描述',
          status: 'pending',
          toolCalls: [],
          dependencies: [],
        },
      ],
      metadata: {
        createdAt: new Date('2026-08-07T10:00:00Z'),
        estimatedTokens: 0,
        risks: [],
      },
    },
    createdAt: updatedAt,
    updatedAt,
  };
}

test('PlanStore saves and lists documents round-trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-plans-roundtrip-'));
  const store = new PlanStore(directory);

  await store.save(createPlanDoc('plan-1', '计划一', 1000));
  await store.save(createPlanDoc('plan-2', '计划二', 2000));

  const docs = await store.list();
  assert.equal(docs.length, 2);
  // 按 updatedAt 降序
  assert.equal(docs[0]?.id, 'plan-2');
  assert.equal(docs[1]?.id, 'plan-1');
  assert.equal(docs[1]?.markdown, '# 计划一\n\n## 执行步骤\n\n1. 步骤一');
  assert.equal(docs[1]?.plan.status, 'draft');
});

test('PlanStore keeps createdAt across updates and refreshes updatedAt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-plans-createdat-'));
  const store = new PlanStore(directory);

  const first = createPlanDoc('plan-x', '计划X', 1000);
  await store.save(first);
  const second = createPlanDoc('plan-x', '计划X（更新）', 5000);
  second.plan.status = 'approved';
  await store.save(second);

  const docs = await store.list();
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.createdAt, 1000);
  // 保存时 updatedAt 取当前时间，必然晚于第二次保存传入的 5000
  assert.ok(docs[0] && docs[0].updatedAt >= 5000);
  assert.equal(docs[0]?.plan.status, 'approved');
});

test('PlanStore skips corrupt or invalid files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-plans-invalid-'));
  const store = new PlanStore(directory);
  await store.save(createPlanDoc('plan-ok', 'OK', 1000));

  await writeFile(join(directory, 'broken.json'), 'not-json{', 'utf-8');
  await writeFile(join(directory, 'missing-fields.json'), JSON.stringify({ id: 'no-markdown' }), 'utf-8');
  await writeFile(join(directory, 'ignored.txt'), 'ignored', 'utf-8');

  const docs = await store.list();
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.id, 'plan-ok');
});

test('PlanStore sanitizes plan ids for file names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-plans-sanitize-'));
  const store = new PlanStore(directory);

  await store.save(createPlanDoc('plan a/b?c', 'Sanitized', 1000));

  const files = await readdir(directory);
  assert.ok(files.some((file) => file === 'plan_a_b_c.json'), `files: ${files.join(', ')}`);
  const docs = await store.list();
  assert.equal(docs[0]?.id, 'plan a/b?c');
});

test('PlanStore caps the number of stored documents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-plans-cap-'));
  const store = new PlanStore(directory);

  for (let index = 0; index < 205; index += 1) {
    await store.save(createPlanDoc(`plan-cap-${index}`, `计划 ${index}`, index));
  }

  const docs = await store.list();
  assert.equal(docs.length, 200);
  // 最旧的 5 份（updatedAt 0-4）被删除
  assert.equal(docs.some((doc) => doc.id === 'plan-cap-0'), false);
  assert.equal(docs.some((doc) => doc.id === 'plan-cap-204'), true);
});

test('GET /api/plans returns persisted plan documents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-plans-'));
  const plansDirectory = join(directory, 'plans');
  await mkdir(plansDirectory);
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
    plansDirectory,
  });

  try {
    // 初始为空
    const emptyResponse = await fetch(`http://127.0.0.1:${instance.port}/api/plans`);
    assert.equal(emptyResponse.status, 200);
    const empty = (await emptyResponse.json()) as { plans: PlanDoc[] };
    assert.deepEqual(empty.plans, []);

    // 手工写入一份文档（等价于 publishPlan 落盘）
    const doc = createPlanDoc('plan-api-1', '接口文档', 3000);
    await writeFile(join(plansDirectory, 'plan-api-1.json'), JSON.stringify(doc), 'utf-8');

    const response = await fetch(`http://127.0.0.1:${instance.port}/api/plans`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { plans: PlanDoc[] };
    assert.equal(payload.plans.length, 1);
    assert.equal(payload.plans[0]?.id, 'plan-api-1');
    assert.equal(payload.plans[0]?.markdown, doc.markdown);
  } finally {
    await instance.close();
  }
});
