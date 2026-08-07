import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_USER_MAX_OPTIONS, AskUserTool } from '../src/index';
import type { ToolContext, UserAnswer, UserQuestion } from '../src/index';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: 'test', workingDirectory: process.cwd(), ...overrides };
}

test('ask_user rejects more than 4 options', () => {
  const tool = new AskUserTool();
  const result = tool.validateParams({
    question: 'Pick one',
    options: ['a', 'b', 'c', 'd', 'e'],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /at most 4/);
});

test('ask_user allows up to 4 options', () => {
  const tool = new AskUserTool();
  const result = tool.validateParams({
    question: 'Pick one',
    options: ['a', 'b', 'c', 'd'],
  });
  assert.equal(result.valid, true);
  assert.equal(ASK_USER_MAX_OPTIONS, 4);
});

test('ask_user forwards multiSelect/allowCustom and formats the answer', async () => {
  const tool = new AskUserTool();
  let received: UserQuestion | undefined;
  const askUser = async (question: UserQuestion): Promise<UserAnswer> => {
    received = question;
    return { selections: ['a', 'c'] };
  };
  const result = await tool.execute(
    { question: 'Which?', options: ['a', 'b', 'c'], multi_select: true },
    context({ askUser }),
  );
  assert.equal(result.success, true);
  assert.equal(received?.multiSelect, true);
  assert.equal(received?.allowCustom, true);
  assert.equal(received?.options.length, 3);
  assert.match(result.content, /User selected: a, c/);
});

test('ask_user custom answer is formatted distinctly', async () => {
  const tool = new AskUserTool();
  const result = await tool.execute(
    { question: 'Which?', options: ['a', 'b'] },
    context({
      askUser: async () => ({ selections: [], custom: 'something else' }),
    }),
  );
  assert.equal(result.success, true);
  assert.match(result.content, /User answered \(custom\): something else/);
});

test('ask_user falls back to text when no interactive handler exists', async () => {
  const tool = new AskUserTool();
  const result = await tool.execute(
    { question: 'Which?', options: ['a', 'b'] },
    context(),
  );
  assert.equal(result.success, true);
  assert.match(result.content, /\[QUESTION\] Which\?/);
  assert.match(result.content, /no interactive input available/);
});

test('ask_user aborts cleanly on signal abort', async () => {
  const tool = new AskUserTool();
  const controller = new AbortController();
  const pending = tool.execute(
    { question: 'Which?', options: ['a'] },
    context({
      signal: controller.signal,
      askUser: (_question, signal) =>
        new Promise<UserAnswer>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    }),
  );
  controller.abort();
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.metadata?.interrupted, true);
});

test('allow_custom=false disables the custom option flag', async () => {
  const tool = new AskUserTool();
  let received: UserQuestion | undefined;
  await tool.execute(
    { question: 'Which?', options: ['a'], allow_custom: false },
    context({
      askUser: async (question) => {
        received = question;
        return { selections: ['a'] };
      },
    }),
  );
  assert.equal(received?.allowCustom, false);
});
