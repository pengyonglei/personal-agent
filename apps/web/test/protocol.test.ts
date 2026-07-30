import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClientMessage } from '../src/protocol';

test('parseClientMessage validates and normalizes prompts', () => {
  assert.deepEqual(parseClientMessage('{"type":"prompt","text":"  hello  "}'), {
    type: 'prompt',
    text: 'hello',
  });
  assert.throws(() => parseClientMessage('{"type":"prompt","text":"   "}'), /不能为空/);
  assert.throws(() => parseClientMessage('not-json'), /JSON/);
});

test('parseClientMessage validates permission responses', () => {
  assert.deepEqual(
    parseClientMessage(
      '{"type":"permission_response","requestId":"req-1","approved":true,"remember":true}',
    ),
    {
      type: 'permission_response',
      requestId: 'req-1',
      approved: true,
      remember: true,
    },
  );
  assert.throws(
    () => parseClientMessage('{"type":"permission_response","approved":true}'),
    /格式无效/,
  );
});

test('parseClientMessage validates project and task commands', () => {
  assert.deepEqual(
    parseClientMessage(
      '{"type":"create_project","name":"  Web UI  ","rootPath":"  D:\\\\workspace\\\\web  "}',
    ),
    {
      type: 'create_project',
      name: 'Web UI',
      rootPath: 'D:\\workspace\\web',
    },
  );
  assert.deepEqual(
    parseClientMessage('{"type":"create_task","projectId":" project-1 ","title":" 修复构建 "}'),
    {
      type: 'create_task',
      projectId: 'project-1',
      title: '修复构建',
    },
  );
  assert.throws(
    () => parseClientMessage('{"type":"create_project","name":"Missing root"}'),
    /name 和 rootPath/,
  );
});
