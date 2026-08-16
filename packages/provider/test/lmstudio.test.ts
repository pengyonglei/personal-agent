import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ProviderFeature } from '@personal-agent/shared';
import { LMStudioProvider, DEFAULT_LMSTUDIO_BASE_URL } from '../src/lmstudio';

test('LM Studio maps thinking strength to reasoning_effort and keeps temperature', async () => {
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
          id: 'lmstudio-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'qwen3.8-27b-a3b-thinking',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.write(chunk({ role: 'assistant', reasoning_content: '先思考' }));
      response.write(chunk({ content: '答案' }));
      response.write(chunk({}, 'stop'));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const provider = new LMStudioProvider(
    'lm-studio',
    'qwen3.8-27b-a3b-thinking',
    `http://127.0.0.1:${address.port}`,
    ['qwen3.8-27b-a3b-thinking', 'qwen3-14b'],
  );
  await provider.initialize();

  try {
    const events = [];
    for await (const event of provider.streamChat([{ role: 'user', content: '分析一下' }], [], {
      reasoningEffort: 'xhigh',
      temperature: 0.4,
    })) {
      events.push(event);
    }

    assert.deepEqual(
      events.filter((event) => event.type === 'thinking_delta'),
      [{ type: 'thinking_delta', thinkingDelta: '先思考' }],
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'text_delta'),
      [{ type: 'text_delta', textDelta: '答案' }],
    );

    const xhighRequest = requestBodies[0];
    assert.equal(xhighRequest.reasoning_effort, 'xhigh');
    // LM Studio 允许 temperature 与 reasoning_effort 共存（与 DeepSeek 不同）
    assert.equal(xhighRequest.temperature, 0.4);

    const efforts = {
      off: 'none',
      low: 'low',
      medium: 'medium',
      high: 'xhigh',
      max: 'xhigh',
      xhigh: 'xhigh',
    } as const;
    let index = 1;
    for (const [effort, wire] of Object.entries(efforts)) {
      for await (const _event of provider.streamChat([{ role: 'user', content: '回答' }], [], {
        reasoningEffort: effort as keyof typeof efforts,
        temperature: 0.2,
      })) {
        // Consume the stream so the request body can be asserted.
      }
      assert.equal(requestBodies[index]?.reasoning_effort, wire, `effort=${effort}`);
      index += 1;
    }

    // 未指定 reasoningEffort 时省略该字段，交给 LM Studio 使用模型默认值
    for await (const _event of provider.streamChat([{ role: 'user', content: '默认' }], [], {})) {
      // Consume the stream so the request body can be asserted.
    }
    assert.equal('reasoning_effort' in requestBodies[index], false);
  } finally {
    await provider.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('LM Studio non-streaming chat surfaces reasoning_content as thinking block', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'lmstudio-test',
          object: 'chat.completion',
          created: 1,
          model: 'qwen3.8-27b-a3b-thinking',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', reasoning_content: '思考内容', content: '正文' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const provider = new LMStudioProvider(
    'lm-studio',
    'qwen3.8-27b-a3b-thinking',
    `http://127.0.0.1:${address.port}`,
  );
  await provider.initialize();

  try {
    const response = await provider.chat([{ role: 'user', content: '你好' }]);
    assert.deepEqual(response.content, [
      { type: 'thinking', thinking: '思考内容' },
      { type: 'text', text: '正文' },
    ]);
    assert.equal(response.usage?.inputTokens, 10);
    assert.equal(response.usage?.outputTokens, 20);
  } finally {
    await provider.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('LM Studio models are fully user-defined and imageInput is honored', () => {
  const provider = new LMStudioProvider(
    'lm-studio',
    'qwen3.8-27b-a3b-thinking',
    DEFAULT_LMSTUDIO_BASE_URL,
    [
      'qwen3-14b',
      { id: 'qwen3-vl-8b', contextWindow: 65_536, maxOutputTokens: 4_096, imageInput: true },
    ],
  );
  const byId = new Map(provider.getModelList().map((model) => [model.id, model]));
  assert.equal(byId.size, 3);
  assert.equal(byId.get('qwen3-14b')?.features.includes(ProviderFeature.ImageInput), false);
  assert.equal(byId.get('qwen3-vl-8b')?.contextWindow, 65_536);
  assert.equal(byId.get('qwen3-vl-8b')?.maxOutputTokens, 4_096);
  assert.equal(byId.get('qwen3-vl-8b')?.features.includes(ProviderFeature.ImageInput), true);
  assert.equal(
    byId.get('qwen3.8-27b-a3b-thinking')?.features.includes(ProviderFeature.Thinking),
    true,
  );
});
