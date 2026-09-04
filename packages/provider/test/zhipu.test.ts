import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ZhipuProvider } from '../src/zhipu';

test('Zhipu sends thinking toggle, preserves reasoning content, and maps cached tokens', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'keep-alive',
      });
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({
          id: 'zhipu-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'glm-4.6',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.write(chunk({ role: 'assistant', reasoning_content: '先分析' }));
      response.write(chunk({ content: '答案' }));
      // 最后一个 chunk 携带 usage（智谱 OpenAI 兼容层支持 stream_options.include_usage）
      response.write(
        `data: ${JSON.stringify({
          id: 'zhipu-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'glm-4.6',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 64 },
          },
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const provider = new ZhipuProvider(
    'test-key',
    'glm-4.6',
    `http://127.0.0.1:${address.port}`,
    ['glm-4.6', 'glm-4.5'],
  );
  await provider.initialize();

  try {
    const events = [];
    for await (const event of provider.streamChat(
      [
        { role: 'user', content: '读取文件' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '需要先读取文件' },
            { type: 'text', text: '我来读取。' },
          ],
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"README.md"}' },
            },
          ],
        },
        { role: 'tool', toolCallId: 'call-1', content: 'file contents' },
      ],
      [],
      { reasoningEffort: 'high', temperature: 0.8 },
    )) {
      events.push(event);
    }

    assert.deepEqual(
      events.filter((event) => event.type === 'thinking_delta'),
      [{ type: 'thinking_delta', thinkingDelta: '先分析' }],
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'text_delta'),
      [{ type: 'text_delta', textDelta: '答案' }],
    );

    const enabledRequest = requestBodies[0];
    assert.deepEqual(enabledRequest.thinking, { type: 'enabled' });
    // 智谱没有 effort 档位，不得透传 reasoning_effort
    assert.equal('reasoning_effort' in enabledRequest, false);
    // 深度思考开启时省略 temperature
    assert.equal('temperature' in enabledRequest, false);
    const enabledMessages = enabledRequest.messages as Array<Record<string, unknown>>;
    const assistant = enabledMessages.find((message) => message.role === 'assistant');
    assert.equal(assistant?.reasoning_content, '需要先读取文件');

    // message_end 携带缓存命中 token
    const messageEnd = events.find((event) => event.type === 'message_end');
    assert.ok(messageEnd && messageEnd.type === 'message_end');
    assert.deepEqual(messageEnd.usage, {
      inputTokens: 100,
      outputTokens: 20,
      cacheHitTokens: 64,
    });

    for await (const _event of provider.streamChat([{ role: 'user', content: '直接回答' }], [], {
      reasoningEffort: 'off',
      temperature: 0.3,
    })) {
      // Consume the stream so the request body can be asserted.
    }
    const disabledRequest = requestBodies[1];
    assert.deepEqual(disabledRequest.thinking, { type: 'disabled' });
    assert.equal(disabledRequest.temperature, 0.3);
    assert.equal('reasoning_effort' in disabledRequest, false);

    // 未指定思考强度时不发送 thinking 字段（跟随 API 默认行为）
    for await (const _event of provider.streamChat([{ role: 'user', content: '默认行为' }], [], {
      temperature: 0.5,
    })) {
      // Consume the stream.
    }
    const defaultRequest = requestBodies[2];
    assert.equal('thinking' in defaultRequest, false);
    assert.equal(defaultRequest.temperature, 0.5);
  } finally {
    await provider.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('Zhipu model list follows configured models, catalog is only a fallback', () => {
  // 显式配置 models 时以配置为准 —— 设置页删除的模型不得再出现在选择器中
  const configured = new ZhipuProvider(
    'test-key',
    'glm-5.3-flash',
    'https://open.bigmodel.cn/api/paas/v4',
    ['glm-5.3-flash'],
  );
  assert.deepEqual(
    configured.getModelList().map((model) => model.id),
    ['glm-5.3-flash'],
  );

  // 未配置 models 时回退到内置目录，默认模型也在列
  const fallback = new ZhipuProvider('test-key', 'glm-4.6');
  assert.ok(fallback.getModelList().some((model) => model.id === 'glm-4.6'));
  assert.ok(fallback.getModelList().some((model) => model.id === 'glm-4.5-flash'));

  // 配置对象覆盖内置元数据
  const withConfig = new ZhipuProvider('test-key', 'glm-4.6', undefined, [
    { id: 'glm-4.6', contextWindow: 123_456 },
  ]);
  assert.deepEqual(
    withConfig.getModelList().map((model) => model.id),
    ['glm-4.6'],
  );
  assert.equal(withConfig.getModelList()[0].contextWindow, 123_456);
});

test('Zhipu streams tool calls and defaults to glm-4.6', async () => {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      connection: 'keep-alive',
    });
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
      `data: ${JSON.stringify({
        id: 'zhipu-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'glm-4.6',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    response.write(chunk({ tool_calls: [{ index: 0, id: 'call-9', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }));
    response.write(chunk({}, 'tool_calls'));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const provider = new ZhipuProvider('test-key', 'glm-4.6', `http://127.0.0.1:${address.port}`);
  await provider.initialize();

  try {
    assert.equal(provider.getModel(), 'glm-4.6');
    assert.ok(provider.getModelList().some((model) => model.id === 'glm-4.6'));
    assert.ok(provider.getModelList().some((model) => model.id === 'glm-4.5-flash'));

    const events = [];
    for await (const event of provider.streamChat([{ role: 'user', content: '执行命令' }], [], {})) {
      events.push(event);
    }
    const toolCallEnd = events.find((event) => event.type === 'tool_call_end');
    assert.ok(toolCallEnd && toolCallEnd.type === 'tool_call_end');
    assert.deepEqual(toolCallEnd.toolCallEnd, {
      id: 'call-9',
      name: 'bash',
      arguments: { command: 'ls' },
    });
    const messageEnd = events.find((event) => event.type === 'message_end');
    assert.ok(messageEnd && messageEnd.type === 'message_end');
    assert.equal(messageEnd.stopReason, 'tool_use');
  } finally {
    await provider.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
