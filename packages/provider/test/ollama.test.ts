import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderFeature } from '@personal-agent/shared';
import { OllamaProvider } from '../src/ollama';

test('OllamaProvider parses native NDJSON streaming responses and tool calls', async () => {
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/tags')) {
      return Response.json({
        models: [{ name: 'qwen3:8b' }, { name: 'qwen2.5:latest' }],
      });
    }
    const request = JSON.parse(String(init?.body)) as {
      stream: boolean;
      tools: unknown[];
    };
    assert.equal(request.stream, true);
    assert.equal(request.tools.length, 1);
    return new Response(
      [
        JSON.stringify({ model: 'qwen3:8b', message: { content: 'Hello ' }, done: false }),
        JSON.stringify({
          model: 'qwen3:8b',
          message: {
            content: 'world',
            tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }],
          },
          done: false,
        }),
        JSON.stringify({
          model: 'qwen3:8b',
          message: { content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 12,
          eval_count: 4,
        }),
      ].join('\n'),
      { headers: { 'content-type': 'application/x-ndjson' } },
    );
  };

  const provider = new OllamaProvider('qwen3:8b', 'http://ollama.test', fetchMock, [
    'qwen3:8b',
    'qwen3:32b',
  ]);
  await provider.initialize();
  // 本机 /api/tags 发现的其他模型不应混入模型列表，只保留配置的模型。
  assert.deepEqual(
    provider.getModelList().map((model) => model.id),
    ['qwen3:8b', 'qwen3:32b'],
  );

  const events = [];
  for await (const event of provider.streamChat(
    [{ role: 'user', content: 'hello' }],
    [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
    {},
  )) {
    events.push(event);
  }

  assert.deepEqual(
    events.filter((event) => event.type === 'text_delta').map((event) => event.textDelta),
    ['Hello ', 'world'],
  );
  const tool = events.find((event) => event.type === 'tool_call_end');
  assert.equal(tool?.type, 'tool_call_end');
  if (tool?.type === 'tool_call_end') {
    assert.equal(tool.toolCallEnd.name, 'read_file');
    assert.deepEqual(tool.toolCallEnd.arguments, { path: 'README.md' });
  }
  const end = events.find((event) => event.type === 'message_end');
  assert.equal(end?.type, 'message_end');
  if (end?.type === 'message_end') {
    assert.equal(end.stopReason, 'tool_use');
    assert.deepEqual(end.usage, { inputTokens: 12, outputTokens: 4 });
  }
});

test('OllamaProvider exposes configured image input capability and sends image data', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchMock: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      model: 'qwen2.5vl:7b',
      message: { role: 'assistant', content: '{"passed":true,"summary":"ok"}' },
      done: true,
      done_reason: 'stop',
    });
  };
  const provider = new OllamaProvider('qwen2.5vl:7b', 'http://ollama.test', fetchMock, [
    { id: 'qwen2.5vl:7b', imageInput: true },
    'qwen3:8b',
  ]);

  assert.equal(
    provider
      .getModelList()
      .find((model) => model.id === 'qwen2.5vl:7b')
      ?.features.includes(ProviderFeature.ImageInput),
    true,
  );
  assert.equal(
    provider
      .getModelList()
      .find((model) => model.id === 'qwen3:8b')
      ?.features.includes(ProviderFeature.ImageInput),
    false,
  );
  assert.equal(provider.supportsFeature(ProviderFeature.ImageInput), true);

  await provider.chat([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Review this screenshot.' },
        { type: 'image', source: { data: 'aW1hZ2U=', mediaType: 'image/png' } },
      ],
    },
  ]);

  assert.deepEqual(requestBody?.messages, [
    {
      role: 'user',
      content: 'Review this screenshot.',
      images: ['aW1hZ2U='],
    },
  ]);
});

test('OllamaProvider exposes per-model reasoning options and maps effort verbatim', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      model: 'qwen3:8b',
      message: { role: 'assistant', reasoning: '思考过程', content: '回答内容' },
      done: true,
      done_reason: 'stop',
    });
  };
  const provider = new OllamaProvider('qwen3:8b', 'http://ollama.test', fetchMock, [
    { id: 'qwen3:8b', reasoningOptions: ['off', 'medium', 'high', 'max'] },
    'llama3.1',
  ]);

  // 配置了 reasoningOptions 的模型具备 Thinking 能力并携带档位子集；未配置的没有。
  const qwen3 = provider.getModelList().find((model) => model.id === 'qwen3:8b');
  assert.equal(qwen3?.features.includes(ProviderFeature.Thinking), true);
  assert.deepEqual(qwen3?.reasoningOptions, ['off', 'medium', 'high', 'max']);
  const llama = provider.getModelList().find((model) => model.id === 'llama3.1');
  assert.equal(llama?.features.includes(ProviderFeature.Thinking), false);

  // off → think:false，不发送 reasoning_effort。
  await provider.chat([{ role: 'user', content: 'hi' }], [], { reasoningEffort: 'off' });
  assert.equal(bodies[bodies.length - 1]?.think, false);
  assert.equal('reasoning_effort' in (bodies[bodies.length - 1] ?? {}), false);

  // 档位原样透传（xhigh / max 不做归一化），并携带 think:true。
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    await provider.chat([{ role: 'user', content: 'hi' }], [], { reasoningEffort: effort });
    const body = bodies[bodies.length - 1];
    assert.equal(body?.think, true, `effort=${effort}`);
    assert.equal(body?.reasoning_effort, effort, `effort=${effort}`);
  }

  // 非流式响应中的 reasoning 提取为 ThinkingContentBlock。
  const result = await provider.chat([{ role: 'user', content: 'hi' }], [], {
    reasoningEffort: 'high',
  });
  assert.deepEqual(result.content, [
    { type: 'thinking', thinking: '思考过程' },
    { type: 'text', text: '回答内容' },
  ]);
});

test('OllamaProvider serializes structured tool results into tool message content', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      model: 'qwen3:8b',
      message: { role: 'assistant', content: '看到了' },
      done: true,
      done_reason: 'stop',
    });
  };
  const provider = new OllamaProvider('qwen3:8b', 'http://ollama.test', fetchMock, ['qwen3:8b']);

  // 结构化 tool_result 块（agent-loop 记录的形态）必须原样进入 Ollama 的 content。
  await provider.chat([
    {
      role: 'assistant',
      content: [],
      toolCalls: [
        { id: 'call_1', type: 'function', function: { name: 'list_directory', arguments: '{}' } },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'd src\nf README.md\n' }],
    },
  ]);
  assert.deepEqual(bodies[bodies.length - 1]?.messages, [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'list_directory', arguments: {} } }],
    },
    {
      role: 'tool',
      content: 'd src\nf README.md\n',
    },
  ]);

  // 失败结果带 [tool error] 前缀，空输出兜底 '(no output)'。
  await provider.chat([
    {
      role: 'tool',
      toolCallId: 'call_2',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'call_2',
          content: '',
          isError: true,
          error: 'Exit code: 1',
        },
      ],
    },
  ]);
  assert.equal(
    (bodies[bodies.length - 1]?.messages as Array<Record<string, unknown>>)[0]?.content,
    '[tool error] (no output)',
  );
});

test('OllamaProvider streams reasoning content as thinking_delta', async () => {
  const fetchMock: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      think: boolean;
      reasoning_effort: string;
    };
    assert.equal(request.think, true);
    assert.equal(request.reasoning_effort, 'medium');
    return new Response(
      [
        JSON.stringify({ model: 'qwen3:8b', message: { reasoning: '先' }, done: false }),
        JSON.stringify({ model: 'qwen3:8b', message: { reasoning: '想' }, done: false }),
        JSON.stringify({ model: 'qwen3:8b', message: { content: '答' }, done: false }),
        JSON.stringify({ model: 'qwen3:8b', message: {}, done: true, done_reason: 'stop' }),
      ].join('\n'),
      { headers: { 'content-type': 'application/x-ndjson' } },
    );
  };
  const provider = new OllamaProvider('qwen3:8b', 'http://ollama.test', fetchMock, [
    { id: 'qwen3:8b', reasoningOptions: ['off', 'low', 'medium', 'high'] },
  ]);

  const events = [];
  for await (const event of provider.streamChat(
    [{ role: 'user', content: 'hi' }],
    [],
    { reasoningEffort: 'medium' },
  )) {
    events.push(event);
  }
  assert.deepEqual(
    events.filter((event) => event.type === 'thinking_delta').map((event) => event.thinkingDelta),
    ['先', '想'],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'text_delta').map((event) => event.textDelta),
    ['答'],
  );
});
