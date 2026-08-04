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
