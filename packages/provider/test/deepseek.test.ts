import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { DeepSeekProvider } from '../src/deepseek';

test('DeepSeek sends thinking settings and preserves reasoning content across tool turns', async () => {
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
          id: 'deepseek-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.write(chunk({ role: 'assistant', reasoning_content: '先分析' }));
      response.write(chunk({ content: '答案' }));
      response.write(chunk({}, 'stop'));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const provider = new DeepSeekProvider(
    'test-key',
    'deepseek-v4-pro',
    `http://127.0.0.1:${address.port}`,
    ['deepseek-v4-flash', 'deepseek-v4-pro'],
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
      { reasoningEffort: 'max', temperature: 0.8 },
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
    assert.equal(enabledRequest.reasoning_effort, 'max');
    assert.equal('temperature' in enabledRequest, false);
    const enabledMessages = enabledRequest.messages as Array<Record<string, unknown>>;
    const assistant = enabledMessages.find((message) => message.role === 'assistant');
    assert.equal(assistant?.reasoning_content, '需要先读取文件');

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

    for await (const _event of provider.streamChat([{ role: 'user', content: '简短回答' }], [], {
      reasoningEffort: 'low',
      temperature: 0.5,
    })) {
      // Consume the stream so the request body can be asserted.
    }
    const lowRequest = requestBodies[2];
    assert.deepEqual(lowRequest.thinking, { type: 'enabled' });
    assert.equal(lowRequest.reasoning_effort, 'low');
    assert.equal('temperature' in lowRequest, false);
  } finally {
    await provider.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('DeepSeek normalizes legacy model ids', () => {
  const provider = new DeepSeekProvider('test-key', 'deepseek-reasoner');
  assert.equal(provider.getModel(), 'deepseek-v4-flash');
  assert.ok(provider.getModelList().some((model) => model.id === 'deepseek-v4-flash'));
  assert.ok(provider.getModelList().some((model) => model.id === 'deepseek-v4-pro'));
});

test('DeepSeek serializes structured tool results with error flag, metadata, and empty-output fallback', async () => {
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
      response.write(
        `data: ${JSON.stringify({
          id: 'deepseek-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const provider = new DeepSeekProvider(
    'test-key',
    'deepseek-v4-flash',
    `http://127.0.0.1:${address.port}`,
  );
  await provider.initialize();

  try {
    const messages = [
      { role: 'user' as const, content: '执行工具' },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_use' as const,
            id: 'call-1',
            name: 'edit_file',
            input: { file_path: '/a/b.ts' },
          },
          {
            type: 'tool_use' as const,
            id: 'call-2',
            name: 'read_file',
            input: { path: '/a/c.ts' },
          },
        ],
        toolCalls: [
          {
            id: 'call-1',
            type: 'function' as const,
            function: { name: 'edit_file', arguments: '{"file_path":"/a/b.ts"}' },
          },
          {
            id: 'call-2',
            type: 'function' as const,
            function: { name: 'read_file', arguments: '{"path":"/a/c.ts"}' },
          },
        ],
      },
      // 结构化成功结果：带 fileModified / truncated metadata
      {
        role: 'tool' as const,
        toolCallId: 'call-1',
        content: [
          {
            type: 'tool_result' as const,
            toolUseId: 'call-1',
            content: 'File edited successfully: /a/b.ts',
            isError: false,
            metadata: { fileModified: ['/a/b.ts'] },
          },
        ],
      },
      // 结构化失败结果：isError + error，且内容为空（测试兜底）
      {
        role: 'tool' as const,
        toolCallId: 'call-2',
        content: [
          {
            type: 'tool_result' as const,
            toolUseId: 'call-2',
            content: '',
            isError: true,
            error: 'File not found: /a/c.ts',
          },
        ],
      },
    ];

    for await (const _event of provider.streamChat(messages, [], {})) {
      // Consume the stream so the request body can be asserted.
    }

    const wire = requestBodies[0].messages as Array<Record<string, unknown>>;
    const toolMessages = wire.filter((m) => m.role === 'tool');

    // 成功结果：保留原始文本，无错误前缀
    assert.equal(toolMessages[0]?.tool_call_id, 'call-1');
    assert.equal(toolMessages[0]?.content, 'File edited successfully: /a/b.ts');

    // 失败结果：isError → [tool error] 前缀；空 content → (no output) 兜底
    assert.equal(toolMessages[1]?.tool_call_id, 'call-2');
    assert.equal(toolMessages[1]?.content, '[tool error] (no output)');
  } finally {
    await provider.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('DeepSeek serializes legacy string tool messages and drops tool messages without toolCallId', async () => {
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
      response.write(
        `data: ${JSON.stringify({
          id: 'deepseek-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const provider = new DeepSeekProvider(
    'test-key',
    'deepseek-v4-flash',
    `http://127.0.0.1:${address.port}`,
  );
  await provider.initialize();

  try {
    const messages = [
      { role: 'user' as const, content: '读取文件' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 'call-1', name: 'read_file', input: {} }],
        toolCalls: [
          {
            id: 'call-1',
            type: 'function' as const,
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      // 旧会话：纯字符串 content（成功）
      { role: 'tool' as const, toolCallId: 'call-1', content: 'file contents' },
      // 旧会话：纯字符串 content 以 Error: 开头（失败）
      { role: 'tool' as const, toolCallId: 'call-2', content: 'Error: boom' },
      // 损坏消息：缺 toolCallId，应被整体丢弃
      { role: 'tool' as const, content: 'orphan result' } as never,
    ];

    for await (const _event of provider.streamChat(messages, [], {})) {
      // Consume the stream so the request body can be asserted.
    }

    const wire = requestBodies[0].messages as Array<Record<string, unknown>>;
    const toolMessages = wire.filter((m) => m.role === 'tool');

    // 旧字符串成功消息原样保留
    assert.equal(toolMessages[0]?.tool_call_id, 'call-1');
    assert.equal(toolMessages[0]?.content, 'file contents');

    // 旧字符串失败消息：Error: 前缀 → [tool error] 前缀
    assert.equal(toolMessages[1]?.tool_call_id, 'call-2');
    assert.equal(toolMessages[1]?.content, '[tool error] Error: boom');

    // 缺 toolCallId 的孤儿 tool 消息被过滤
    assert.equal(toolMessages.length, 2);
  } finally {
    await provider.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
