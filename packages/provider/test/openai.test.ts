import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { OpenAIProvider } from '../src/openai';

test('OpenAI does not send DeepSeek-only thinking parameters and keeps temperature', async () => {
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
          id: 'openai-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-4o',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.write(chunk({ role: 'assistant', content: '你好' }));
      response.write(chunk({}, 'stop'));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const provider = new OpenAIProvider('test-key', 'gpt-4o', `http://127.0.0.1:${address.port}`, [
    'gpt-4o',
  ]);
  await provider.initialize();

  try {
    const events = [];
    for await (const event of provider.streamChat(
      [
        { role: 'user', content: '你好' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '内部思考' },
            { type: 'text', text: '回复' },
          ],
        },
      ],
      [],
      { reasoningEffort: 'high', temperature: 0.7 },
    )) {
      events.push(event);
    }

    assert.deepEqual(
      events.filter((event) => event.type === 'text_delta'),
      [{ type: 'text_delta', textDelta: '你好' }],
    );

    const request = requestBodies[0];
    assert.equal(request.temperature, 0.7);
    assert.equal('thinking' in request, false);
    assert.equal('reasoning_effort' in request, false);
    const messages = request.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === 'assistant');
    assert.equal('reasoning_content' in (assistant ?? {}), false);
  } finally {
    await provider.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
