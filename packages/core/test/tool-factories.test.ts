import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Tool, ToolContext } from '@personal-agent/tool';
import { PlanModeEngine } from '../src/plan-mode';
import { createMemoryTools, createPlanTools, formatPlan } from '../src/tool-factories';

const ctx: ToolContext = { sessionId: 'test-session', workingDirectory: process.cwd() };

function toolsByName(tools: Tool[]): Record<string, Tool> {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

// ---------------------------------------------------------------------------
// createPlanTools
// ---------------------------------------------------------------------------

test('createPlanTools 返回 3 个工具且描述为统一版本（防漂移）', () => {
  const tools = toolsByName(createPlanTools({ isPlanModeActive: () => false, getPlanEngine: () => null }));
  assert.equal(Object.keys(tools).length, 3);
  assert.deepEqual(
    Object.keys(tools).sort(),
    ['get_plan', 'submit_plan', 'update_plan_step'],
  );
  assert.equal(
    tools.submit_plan.description,
    'Submit a structured implementation plan for user approval, including dependencies and risks. Use stable step ids such as step-1 and reference those ids from dependencies.',
  );
  assert.equal(
    tools.get_plan.description,
    'Get the current structured plan and its execution progress.',
  );
  assert.equal(
    tools.update_plan_step.description,
    'Update a step in the approved plan as execution progresses.',
  );
});

test('submit_plan 在计划模式外被拒绝，激活后可创建并由 get_plan 读回', async () => {
  const engine = new PlanModeEngine();
  const host = { isPlanModeActive: () => false, getPlanEngine: () => engine };
  const tools = toolsByName(createPlanTools(host));

  const rejected = await tools.submit_plan.execute({ title: 'T', steps: [] }, ctx);
  assert.equal(rejected.success, false);
  assert.equal(rejected.error, 'submit_plan is only available in plan mode');

  host.isPlanModeActive = () => true;
  const created = await tools.submit_plan.execute(
    { title: 'T', steps: [{ title: 's1', description: 'd' }] },
    ctx,
  );
  assert.equal(created.success, true);
  assert.match(created.content ?? '', /T \[draft\]/);

  const read = await tools.get_plan.execute({}, ctx);
  assert.equal(read.success, true);
  assert.match(read.content ?? '', /Progress: 0\/1 completed/);

  // 无可用 planEngine（如会话路由失败）时返回 'No active plan.'
  const emptyTools = toolsByName(
    createPlanTools({ isPlanModeActive: () => false, getPlanEngine: () => null }),
  );
  const readEmpty = await emptyTools.get_plan.execute({}, ctx);
  assert.equal(readEmpty.content, 'No active plan.');
});

test('update_plan_step 覆盖 in_progress/completed/failed/skipped 四状态与返回文本', async () => {
  const engine = new PlanModeEngine();
  const host = { isPlanModeActive: () => true, getPlanEngine: () => engine };
  const tools = toolsByName(createPlanTools(host));

  await tools.submit_plan.execute(
    {
      title: 'P',
      steps: [
        { title: 'a', description: '' },
        { title: 'b', description: '' },
      ],
    },
    ctx,
  );
  engine.approvePlan();

  // in_progress
  const started = await tools.update_plan_step.execute(
    { step_id: 'step-1', status: 'in_progress' },
    ctx,
  );
  assert.equal(started.success, true);
  assert.match(started.content ?? '', /Step step-1 is in_progress\. Progress: 0%/);

  // completed
  const completed = await tools.update_plan_step.execute(
    { step_id: 'step-1', status: 'completed', output: 'done' },
    ctx,
  );
  assert.equal(completed.success, true);
  assert.match(completed.content ?? '', /Step step-1 is completed\. Progress: 50%/);

  // failed（需要先 in_progress）
  await tools.update_plan_step.execute({ step_id: 'step-2', status: 'in_progress' }, ctx);
  const failed = await tools.update_plan_step.execute(
    { step_id: 'step-2', status: 'failed', output: 'boom' },
    ctx,
  );
  assert.equal(failed.success, true);
  assert.match(failed.content ?? '', /Step step-2 is failed\. Progress: 100%/);

  // 未知步骤
  const unknown = await tools.update_plan_step.execute(
    { step_id: 'step-99', status: 'in_progress' },
    ctx,
  );
  assert.equal(unknown.success, false);
  assert.match(unknown.error ?? '', /Unknown step\/status: step-99\/in_progress/);

  // skipped（新计划）
  const engine2 = new PlanModeEngine();
  const host2 = { isPlanModeActive: () => true, getPlanEngine: () => engine2 };
  const tools2 = toolsByName(createPlanTools(host2));
  await tools2.submit_plan.execute({ title: 'Q', steps: [{ title: 'a', description: '' }] }, ctx);
  engine2.approvePlan();
  const skipped = await tools2.update_plan_step.execute(
    { step_id: 'step-1', status: 'skipped' },
    ctx,
  );
  assert.equal(skipped.success, true);
  assert.match(skipped.content ?? '', /Step step-1 is skipped\. Progress: 100%/);
});

test('submit_plan 与 update_plan_step 触发 host.publishPlan 回调', async () => {
  let published = 0;
  const engine = new PlanModeEngine();
  const host = {
    isPlanModeActive: () => true,
    getPlanEngine: () => engine,
    publishPlan: () => {
      published++;
    },
  };
  const tools = toolsByName(createPlanTools(host));

  await tools.submit_plan.execute({ title: 'P', steps: [{ title: 'a', description: '' }] }, ctx);
  assert.equal(published, 1);

  engine.approvePlan();
  await tools.update_plan_step.execute({ step_id: 'step-1', status: 'in_progress' }, ctx);
  assert.equal(published, 2);
});

// ---------------------------------------------------------------------------
// createMemoryTools
// ---------------------------------------------------------------------------

test('createMemoryTools 返回 2 个工具、描述统一、委托给宿主 store', async () => {
  const stored: Array<{ type: string; content: string }> = [];
  const mockStore = {
    search: async (query: string) => [{ entry: { type: 'fact', content: `hit:${query}` } }],
    create: async (data: { type: string; content: string }) => {
      stored.push({ type: data.type, content: data.content });
      return { id: 'mem-1' };
    },
  };
  const host = { getStore: () => mockStore, getSessionId: () => 'session-x' };
  const tools = toolsByName(createMemoryTools(host));

  assert.deepEqual(Object.keys(tools).sort(), ['read_memory', 'write_memory']);
  assert.equal(
    tools.read_memory.description,
    'Search persistent memory for relevant facts and preferences.',
  );
  assert.equal(
    tools.write_memory.description,
    'Persist a fact, preference, or decision for later conversations.',
  );

  const read = await tools.read_memory.execute({ query: 'hello' }, ctx);
  assert.equal(read.success, true);
  assert.equal(read.content, '[fact] hit:hello');

  const written = await tools.write_memory.execute(
    { content: 'remember this', type: 'fact', importance: 1 },
    ctx,
  );
  assert.equal(written.success, true);
  assert.equal(written.content, 'Memory saved: mem-1');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].type, 'fact');
  assert.equal(stored[0].content, 'remember this');

  // importance 校验
  const bad = await tools.write_memory.execute({ content: 'x', importance: 5 }, ctx);
  assert.equal(bad.success, false);
  assert.match(bad.error ?? '', /importance must be 1, 2, or 3/);
});

// ---------------------------------------------------------------------------
// formatPlan
// ---------------------------------------------------------------------------

test('formatPlan 输出标题/进度/步骤标记/风险', () => {
  const engine = new PlanModeEngine();
  const plan = engine.createPlan({
    title: 'My Plan',
    description: 'desc',
    risks: ['r1'],
    steps: [{ id: 'step-1', title: 'Step One', description: 'd' }],
  });
  const text = formatPlan(plan);
  assert.match(text, /My Plan \[draft\]/);
  assert.match(text, /Progress: 0\/1 completed \(0% settled\)/);
  assert.match(text, /\[ \] step-1: Step One/);
  assert.match(text, /Risks: r1/);
});
