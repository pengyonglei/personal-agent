import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop, ContextAssembler, TokenBudget } from '../src/index';
import type {
  AgentEvent,
  LLMProvider,
  UnifiedMessage,
  UnifiedStreamEvent,
  ToolResult,
} from '@personal-agent/shared';
import type { ModelInfo } from '@personal-agent/config';
import { ProviderFeature } from '@personal-agent/shared';

/**
 * 最小 fake LLM provider：每次 streamChat 调用由 responder 决定产出的流事件，
 * 并记录每次调用收到的消息列表（用于断言注入消息是否被携带）。
 */
class FakeProvider implements LLMProvider {
  readonly providerId = 'fake';
  readonly displayName = 'Fake Provider';
  /** 每次 streamChat 调用收到的消息快照。 */
  readonly calls: UnifiedMessage[][] = [];
  private currentModel = 'fake-model';
  private readonly responder: (
    callIndex: number,
    messages: UnifiedMessage[],
  ) => UnifiedStreamEvent[];

  constructor(responder: (callIndex: number, messages: UnifiedMessage[]) => UnifiedStreamEvent[]) {
    this.responder = responder;
  }

  async *streamChat(
    messages: UnifiedMessage[],
    _tools: unknown[],
    _options: { signal?: AbortSignal },
  ): AsyncIterable<UnifiedStreamEvent> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const events = this.responder(this.calls.length - 1, messages);
    for (const event of events) {
      yield event;
    }
  }

  async chat(): Promise<never> {
    throw new Error('not used in tests');
  }

  supportsFeature(): boolean {
    return true;
  }

  getModelList(): ModelInfo[] {
    return [];
  }

  countTokens(messages: UnifiedMessage[]): number {
    return messages.reduce((sum, message) => sum + String(message.content).length, 0);
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  getModel(): string {
    return this.currentModel;
  }

  async initialize(): Promise<void> {}

  async dispose(): Promise<void> {}
}

/** 工具调用流事件（第一轮让模型发起 read_file 工具调用）。 */
function toolCallStream(): UnifiedStreamEvent[] {
  return [
    { type: 'message_start', messageId: 'm-1', model: 'fake-model' },
    { type: 'tool_call_delta', toolCallDelta: { id: 't-1', name: 'read_file' } },
    { type: 'tool_call_delta', toolCallDelta: { id: 't-1', arguments: '{}' } },
    { type: 'tool_call_end', toolCallEnd: { id: 't-1', name: 'read_file', arguments: {} } },
    { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

/** 最终回答流事件（end_turn，无工具调用）。 */
function finalAnswerStream(text: string): UnifiedStreamEvent[] {
  return [
    { type: 'message_start', messageId: 'm-2', model: 'fake-model' },
    { type: 'text_delta', textDelta: text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

function createLoop(provider: FakeProvider, drain: () => string[], maxTurns = 10): AgentLoop {
  const assembler = new ContextAssembler({
    workingDirectory: 'C:\\work',
    platform: 'win32 x64',
    shell: 'powershell',
    model: 'fake-model',
    provider: 'fake',
    mode: 'chat',
  });
  return new AgentLoop({
    provider,
    contextAssembler: assembler,
    tokenBudget: new TokenBudget(100_000, 8192),
    toolDefinitions: [{ name: 'read_file', description: 'Read a file' } as never],
    maxTurns,
    executeTool: async (): Promise<ToolResult> => ({ success: true, content: 'file content' }),
    drainPendingUserMessages: drain,
  });
}

test('injected user messages are drained at the next turn and carried into the model call', async () => {
  const injected: string[] = [];
  // 第一次调用：发起工具调用；第二次调用：给出最终答复
  const provider = new FakeProvider((callIndex) =>
    callIndex === 0 ? toolCallStream() : finalAnswerStream('分析完成'),
  );
  const loop = createLoop(provider, () => injected.splice(0));

  const events: AgentEvent[] = [];
  for await (const event of loop.run('请分析项目')) {
    events.push(event);
    // 工具执行阶段（第一次调用已返回 tool_use）：注入补充消息
    if (event.type === 'tool_call_start') {
      injected.push('注意：请重点检查测试覆盖');
    }
  }

  assert.equal(provider.calls.length, 2, '应有两次模型调用（工具轮 + 注入后的回应轮）');
  const secondCall = provider.calls[1];
  const userTexts = secondCall
    .filter((message) => message.role === 'user')
    .map((message) => String(message.content));
  assert.ok(
    userTexts.some((text) => text.includes('请重点检查测试覆盖')),
    '第二次模型调用应携带注入的补充消息',
  );
  const done = events.find((event) => event.type === 'done') as Extract<
    AgentEvent,
    { type: 'done' }
  >;
  assert.ok(done, '应正常产出 done 事件');
  assert.equal(done.totalTurns, 2);
});

test('transformed model content keeps separate original display content in history', async () => {
  const provider = new FakeProvider(() => finalAnswerStream('完成'));
  const loop = createLoop(provider, () => []);
  const modelContent = '用户问题\n\n视觉模型提取：截图错误 E1001';
  const displayContent = [
    { type: 'text' as const, text: '用户问题' },
    {
      type: 'image' as const,
      name: 'error.png',
      source: { data: 'aW1hZ2U=', mediaType: 'image/png' },
    },
  ];

  for await (const _event of loop.run(modelContent, displayContent)) {
    // consume the loop
  }

  const userMessage = provider.calls[0]?.find((message) => message.role === 'user');
  assert.equal(userMessage?.content, modelContent);
  assert.deepEqual(userMessage?.displayContent, displayContent);
});

test('injection arriving during the final end_turn keeps the loop running instead of finishing', async () => {
  const injected: string[] = [];
  let callCount = 0;
  const provider = new FakeProvider(() => {
    callCount += 1;
    // 每次都先给最终答复；注入发生在流产出期间，应触发循环延续
    return finalAnswerStream(`第 ${callCount} 次回答`);
  });
  const loop = createLoop(provider, () => injected.splice(0));

  const events: AgentEvent[] = [];
  let injectedOnce = false;
  for await (const event of loop.run('你好')) {
    events.push(event);
    // 模型正在流式输出最终答复时注入补充消息（仅注入一次，验证循环延续一轮）
    if (event.type === 'assistant_text_delta' && !injectedOnce) {
      injectedOnce = true;
      injected.push('补充：请再说明一下影响范围');
    }
  }

  assert.equal(provider.calls.length, 2, '注入后循环应继续一轮回应补充消息');
  const secondCall = provider.calls[1];
  const userTexts = secondCall
    .filter((message) => message.role === 'user')
    .map((message) => String(message.content));
  assert.ok(
    userTexts.some((text) => text.includes('请再说明一下影响范围')),
    '延续轮次的模型调用应携带注入消息',
  );
  const done = events.filter((event) => event.type === 'done');
  assert.equal(done.length, 1, '最终只应产出一次 done 事件');
  assert.equal((done[0] as Extract<AgentEvent, { type: 'done' }>).totalTurns, 2);
});

test('unhandled injected messages fall back into history when maxTurns is exhausted', async () => {
  const injected: string[] = [];
  const provider = new FakeProvider(() => toolCallStream());
  // maxTurns=1：第一轮工具执行后循环即退出，注入消息无法被模型回应
  const assembler = new ContextAssembler({
    workingDirectory: 'C:\\work',
    platform: 'win32 x64',
    shell: 'powershell',
    model: 'fake-model',
    provider: 'fake',
    mode: 'chat',
  });
  const loop = new AgentLoop({
    provider,
    contextAssembler: assembler,
    tokenBudget: new TokenBudget(100_000, 8192),
    toolDefinitions: [{ name: 'read_file', description: 'Read a file' } as never],
    maxTurns: 1,
    executeTool: async (): Promise<ToolResult> => ({ success: true, content: 'file content' }),
    drainPendingUserMessages: () => injected.splice(0),
  });

  for await (const event of loop.run('请分析项目')) {
    if (event.type === 'tool_call_start') {
      injected.push('来不及回应的补充消息');
    }
  }

  // 兜底：循环退出后注入消息仍应写回历史（不丢失，下次运行自然携带）
  const historyUserTexts = assembler
    .getHistory()
    .filter((message) => message.role === 'user')
    .map((message) => String(message.content));
  assert.ok(
    historyUserTexts.some((text) => text.includes('来不及回应的补充消息')),
    'maxTurns 耗尽后注入消息应写回历史兜底',
  );
  assert.equal(injected.length, 0, '注入队列应被清空');
});

test('pending system instruction keeps the loop running at end_turn without polluting history', async () => {
  // 模拟「前端验证要求」这类系统级待办：指令不进历史，但会延续循环
  let instructionPending = true;
  let callCount = 0;
  const provider = new FakeProvider(() => {
    callCount += 1;
    // 第二次调用开始前视为模型已处理指令（真实场景中由工具执行清除要求）
    if (callCount === 2) instructionPending = false;
    return finalAnswerStream(`第 ${callCount} 次回答`);
  });
  const assembler = new ContextAssembler({
    workingDirectory: 'C:\\work',
    platform: 'win32 x64',
    shell: 'powershell',
    model: 'fake-model',
    provider: 'fake',
    mode: 'chat',
  });
  const loop = new AgentLoop({
    provider,
    contextAssembler: assembler,
    tokenBudget: new TokenBudget(100_000, 8192),
    toolDefinitions: [{ name: 'read_file', description: 'Read a file' } as never],
    maxTurns: 10,
    executeTool: async (): Promise<ToolResult> => ({ success: true, content: 'file content' }),
    drainPendingUserMessages: () => [],
    hasPendingInstruction: () => instructionPending,
  });

  const events: AgentEvent[] = [];
  for await (const event of loop.run('请分析项目')) {
    events.push(event);
  }

  assert.equal(provider.calls.length, 2, '待办指令存在时循环应延续一轮，指令完成后结束');
  // 系统指令绝不写入对话历史（历史中只有初始 user 消息与两条 assistant 回复）
  const roles = assembler.getHistory().map((message) => message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'assistant'], '指令不应作为消息写入历史');
  const done = events.filter((event) => event.type === 'done');
  assert.equal(done.length, 1, '最终应只产出一次 done 事件');
});
