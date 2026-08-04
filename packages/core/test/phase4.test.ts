import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEvent } from '@personal-agent/shared';
import {
  AgentLoop,
  ContextAssembler,
  PlanModeEngine,
  SessionManager,
  SubAgentManager,
  TokenBudget,
  type ModelCallDebugEnd,
  type ModelCallDebugStart,
} from '../src/index';

test('plan engine enforces approval, dependencies, and completion', async () => {
  const engine = new PlanModeEngine();
  const plan = engine.createPlan({
    title: 'Ship feature',
    steps: [
      { id: 'step-1', title: 'Inspect', description: 'Inspect the code' },
      {
        id: 'step-2',
        title: 'Implement',
        description: 'Implement the feature',
        dependencies: ['step-1'],
      },
    ],
  });

  assert.equal(plan.status, 'draft');
  await assert.rejects(() => engine.startStep('step-1'), /approved/);
  engine.approvePlan();
  assert.equal(engine.getNextStep()?.id, 'step-1');
  await engine.startStep('step-1');
  await engine.completeStep('step-1', 'inspected');
  assert.equal(engine.getNextStep()?.id, 'step-2');
  await engine.startStep('step-2');
  await engine.completeStep('step-2', 'implemented');
  assert.equal(engine.getPlan()?.status, 'completed');
  assert.equal(engine.getProgress().percentage, 100);
});

test('plan engine rejects cyclic dependencies', () => {
  const engine = new PlanModeEngine();
  assert.throws(
    () =>
      engine.createPlan({
        title: 'Invalid',
        steps: [
          { id: 'a', title: 'A', description: 'A', dependencies: ['b'] },
          { id: 'b', title: 'B', description: 'B', dependencies: ['a'] },
        ],
      }),
    /cycle/,
  );
});

test('agent loop applies dynamic tool blocking only when active', async () => {
  for (const blocked of [false, true]) {
    let providerTurn = 0;
    let executed = false;
    const provider = createProvider(async function* () {
      providerTurn++;
      if (providerTurn === 1) {
        yield {
          type: 'tool_call_end',
          toolCallEnd: {
            id: 'call-1',
            name: 'write_file',
            arguments: { path: 'test.txt', content: 'hello' },
          },
        };
        yield {
          type: 'message_end',
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        return;
      }
      yield { type: 'text_delta', textDelta: 'done' };
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const context = createContext();
    const loop = new AgentLoop({
      provider: provider as never,
      contextAssembler: context,
      tokenBudget: new TokenBudget(10_000),
      toolDefinitions: [
        {
          name: 'write_file',
          description: 'write',
          inputSchema: { type: 'object' },
        },
      ],
      maxTurns: 3,
      isToolBlocked: () => blocked,
      executeTool: async () => {
        executed = true;
        return { success: true, content: 'written' };
      },
    });

    for await (const _event of loop.run('write')) {
      // Consume the full run.
    }
    assert.equal(executed, !blocked);
  }
});

test('agent loop reports model request and response diagnostics', async () => {
  const starts: ModelCallDebugStart[] = [];
  const ends: ModelCallDebugEnd[] = [];
  const provider = createProvider(async function* () {
    yield { type: 'message_start', messageId: 'message-1', model: 'mock-model' };
    yield { type: 'text_delta', textDelta: 'hello' };
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 2 },
    };
  });
  const loop = new AgentLoop({
    provider: provider as never,
    contextAssembler: createContext(),
    tokenBudget: new TokenBudget(10_000),
    toolDefinitions: [],
    maxTurns: 1,
    executeTool: async () => ({ success: true, content: '' }),
    streamOptions: { temperature: 0.25, maxTokens: 128 },
    onModelCallStart: (call) => starts.push(call),
    onModelCallEnd: (call) => ends.push(call),
  });

  for await (const _event of loop.run('trace this request')) {
    // Consume the full run.
  }

  assert.equal(starts.length, 1);
  assert.equal(starts[0].provider, 'mock');
  assert.equal(starts[0].model, 'mock');
  assert.equal(starts[0].request.options.temperature, 0.25);
  assert.equal(starts[0].request.messages.at(-1)?.content, 'trace this request');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].callId, starts[0].callId);
  assert.equal(ends[0].status, 'completed');
  assert.equal(ends[0].response.messageId, 'message-1');
  assert.equal(ends[0].response.text, 'hello');
  assert.deepEqual(ends[0].response.usage, { inputTokens: 3, outputTokens: 2 });
});

test('agent loop interrupt stops waiting for a hung tool', async () => {
  let notifyToolStarted: (() => void) | undefined;
  const toolStarted = new Promise<void>((resolve) => {
    notifyToolStarted = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  const provider = createProvider(async function* () {
    yield {
      type: 'tool_call_end',
      toolCallEnd: {
        id: 'hung-call',
        name: 'hung_tool',
        arguments: {},
      },
    };
    yield {
      type: 'message_end',
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const context = createContext();
  const loop = new AgentLoop({
    provider: provider as never,
    contextAssembler: context,
    tokenBudget: new TokenBudget(10_000),
    toolDefinitions: [
      { name: 'hung_tool', description: 'never finishes', inputSchema: { type: 'object' } },
    ],
    maxTurns: 2,
    executeTool: async (_name, _input, signal) => {
      observedSignal = signal;
      notifyToolStarted?.();
      return new Promise<never>(() => undefined);
    },
  });
  const events: AgentEvent[] = [];
  const run = (async () => {
    for await (const event of loop.run('run the stuck tool')) events.push(event);
  })();

  await withTimeout(toolStarted, 500);
  loop.interrupt();
  await withTimeout(run, 500);

  assert.equal(observedSignal?.aborted, true);
  assert.equal(events.at(-1)?.type, 'interrupted');
  const toolEnd = events.find(
    (event): event is Extract<AgentEvent, { type: 'tool_call_end' }> =>
      event.type === 'tool_call_end',
  );
  assert.equal(toolEnd?.result.metadata?.interrupted, true);
  assert.match(String(context.getHistory().at(-1)?.content), /interrupted by user/);
});

test('session messages and metadata survive a reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-session-'));
  try {
    const first = new SessionManager('/workspace', 'mock', 'mock', directory);
    first.replaceMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    first.incrementTurnCount();
    first.addTokensUsed(4, 6);
    const id = await first.save();
    first.addMessage({ role: 'user', content: 'second turn' });
    await first.save();

    const restored = new SessionManager('/other', 'other', 'other', directory);
    assert.equal(await restored.restore(id), true);
    assert.equal(restored.getMessages().length, 3);
    assert.equal(restored.getSession().metadata.turnCount, 1);
    assert.equal(restored.getSession().metadata.totalTokensUsed, 10);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('session token usage is tracked per model and persists across reloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-session-model-usage-'));
  try {
    const first = new SessionManager('/workspace', 'model-a', 'mock', directory);
    first.addTokensUsed(4, 6);
    first.addTokensUsed(2, 1);
    assert.equal(first.getTokensUsed('mock', 'model-a'), 13);
    assert.equal(first.getTokensUsed('mock', 'model-b'), 0);

    first.updateProvider('model-b', 'mock');
    first.addTokensUsed(10, 5);
    assert.equal(first.getTokensUsed('mock', 'model-a'), 13);
    assert.equal(first.getTokensUsed('mock', 'model-b'), 15);
    assert.equal(first.getSession().metadata.totalTokensUsed, 28);

    const id = await first.save();

    const restored = new SessionManager('/other', 'other', 'other', directory);
    assert.equal(await restored.restore(id), true);
    assert.equal(restored.getTokensUsed('mock', 'model-a'), 13);
    assert.equal(restored.getTokensUsed('mock', 'model-b'), 15);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('session records the last request input tokens and persists them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-session-last-input-'));
  try {
    const first = new SessionManager('/workspace', 'model-a', 'mock', directory);
    assert.equal(first.getLastInputTokens(), 0);
    first.setLastInputTokens(1234);
    assert.equal(first.getLastInputTokens(), 1234);
    const id = await first.save();

    const restored = new SessionManager('/other', 'other', 'other', directory);
    assert.equal(await restored.restore(id), true);
    assert.equal(restored.getLastInputTokens(), 1234);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('session token usage falls back to legacy total without per-model records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-session-legacy-'));
  try {
    const id = 'legacy-session';
    const legacy = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      metadata: {
        workingDirectory: '/workspace',
        model: 'old-model',
        provider: 'openai',
        totalTokensUsed: 42,
        totalCost: 0,
        turnCount: 1,
      },
    };
    await writeFile(join(directory, `${id}.json`), JSON.stringify(legacy), 'utf-8');

    const session = new SessionManager('/workspace', 'old-model', 'openai', directory);
    assert.equal(await session.restore(id), true);
    assert.equal(session.getTokensUsed('openai', 'old-model'), 42);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('token compaction summarizes older messages and preserves recent context', async () => {
  const budget = new TokenBudget(100);
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `message-${index}`,
  }));
  const compacted = await budget.compact(messages, 4);
  assert.equal(compacted.length, 5);
  assert.match(String(compacted[0].content), /Earlier conversation summary/);
  assert.deepEqual(
    compacted.slice(1).map((message) => message.content),
    messages.slice(-4).map((message) => message.content),
  );
});

test('sub-agent rejects hallucinated tools outside its allowlist', async () => {
  let providerTurn = 0;
  let globalExecutions = 0;
  const provider = createProvider(async function* () {
    providerTurn++;
    if (providerTurn === 1) {
      yield {
        type: 'tool_call_end',
        toolCallEnd: {
          id: 'call-1',
          name: 'write_file',
          arguments: { path: 'forbidden.txt', content: 'x' },
        },
      };
      yield {
        type: 'message_end',
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      return;
    }
    yield { type: 'text_delta', textDelta: 'finished safely' };
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const manager = new SubAgentManager(async () => {
    globalExecutions++;
    return { success: true, content: 'unexpected' };
  });
  const handle = manager.spawn({
    description: 'Read only',
    prompt: 'Inspect',
    allowedTools: ['read_file'],
    toolDefinitions: [
      { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
      { name: 'write_file', description: 'write', inputSchema: { type: 'object' } },
    ],
    provider: provider as never,
  });
  const result = await handle.result;
  assert.equal(result.success, true);
  assert.equal(result.toolCallsMade, 0);
  assert.equal(globalExecutions, 0);
});

test('sub-agent cancellation aborts the active provider stream', async () => {
  let observedAbort = false;
  const provider = {
    providerId: 'mock',
    displayName: 'Mock',
    getModel: () => 'mock',
    async *streamChat(_messages: unknown, _tools: unknown, options: { signal?: AbortSignal }) {
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener(
          'abort',
          () => {
            observedAbort = true;
            resolve();
          },
          { once: true },
        );
      });
    },
  };
  const manager = new SubAgentManager(async () => ({ success: true, content: '' }));
  const handle = manager.spawn({
    description: 'Wait',
    prompt: 'Wait forever',
    allowedTools: [],
    toolDefinitions: [],
    provider: provider as never,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  handle.cancel();
  const result = await handle.result;
  assert.equal(observedAbort, true);
  assert.equal(result.success, false);
  assert.equal(result.error, 'Cancelled');
});

function createContext() {
  return new ContextAssembler({
    workingDirectory: process.cwd(),
    platform: process.platform,
    model: 'mock',
    provider: 'mock',
    mode: 'chat',
  });
}

function createProvider(streamFactory: () => AsyncGenerator<unknown>) {
  return {
    providerId: 'mock',
    displayName: 'Mock',
    getModel: () => 'mock',
    streamChat: streamFactory,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
