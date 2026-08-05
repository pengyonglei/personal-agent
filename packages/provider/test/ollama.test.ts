import assert from 'node:assert/strict';
import { test } from 'node:test';
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
