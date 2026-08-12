import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClientMessage } from '../src/protocol';

test('parseClientMessage validates and normalizes prompts', () => {
  assert.deepEqual(parseClientMessage('{"type":"prompt","text":"  hello  "}'), {
    type: 'prompt',
    text: 'hello',
    taskId: undefined,
  });
  assert.throws(() => parseClientMessage('{"type":"prompt","text":"   "}'), /不能为空/);
  assert.throws(() => parseClientMessage('not-json'), /JSON/);
});

test('parseClientMessage accepts image prompts and enforces attachment limits', () => {
  const image = {
    name: 'screen.png',
    mediaType: 'image/png',
    data: Buffer.from('fake image').toString('base64'),
  };
  assert.deepEqual(
    parseClientMessage(JSON.stringify({ type: 'prompt', text: '', images: [image] })),
    { type: 'prompt', text: '', images: [image], taskId: undefined },
  );
  assert.throws(
    () =>
      parseClientMessage(
        JSON.stringify({ type: 'prompt', text: 'x', images: [{ ...image, mediaType: 'text/plain' }] }),
      ),
    /支持的图片格式/,
  );
  assert.throws(
    () =>
      parseClientMessage(
        JSON.stringify({ type: 'prompt', text: 'x', images: [{ ...image, data: 'not-base64' }] }),
      ),
    /base64/,
  );
  assert.throws(
    () =>
      parseClientMessage(
        JSON.stringify({ type: 'prompt', text: 'x', images: Array(5).fill(image) }),
      ),
    /最多上传 4 张/,
  );
});

test('parseClientMessage validates inject_user_message', () => {
  assert.deepEqual(
    parseClientMessage('{"type":"inject_user_message","text":"  注意测试  ","taskId":" task-1 "}'),
    {
      type: 'inject_user_message',
      text: '注意测试',
      taskId: 'task-1',
    },
  );
  assert.deepEqual(parseClientMessage('{"type":"inject_user_message","text":"继续"}'), {
    type: 'inject_user_message',
    text: '继续',
    taskId: undefined,
  });
  assert.throws(
    () => parseClientMessage('{"type":"inject_user_message","text":"   "}'),
    /不能为空/,
  );
  assert.throws(() => parseClientMessage('{"type":"inject_user_message"}'), /不能为空/);
  assert.throws(
    () => parseClientMessage('{"type":"inject_user_message","text":"x","taskId":"  "}'),
    /taskId 格式无效/,
  );
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
      taskId: undefined,
    },
  );
  assert.throws(
    () => parseClientMessage('{"type":"permission_response","approved":true}'),
    /格式无效/,
  );
});

test('parseClientMessage validates permission modes', () => {
  for (const mode of ['allow', 'ask', 'approval']) {
    assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'set_permission_mode', mode })), {
      type: 'set_permission_mode',
      mode,
      taskId: undefined,
    });
  }
  assert.throws(
    () => parseClientMessage('{"type":"set_permission_mode","mode":"deny"}'),
    /mode 无效/,
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
  assert.deepEqual(parseClientMessage('{"type":"create_task","projectId":" project-1 "}'), {
    type: 'create_task',
    projectId: 'project-1',
    permissionMode: undefined,
  });
  assert.deepEqual(
    parseClientMessage('{"type":"create_task","projectId":"project-1","permissionMode":"allow"}'),
    {
      type: 'create_task',
      projectId: 'project-1',
      permissionMode: 'allow',
    },
  );
  assert.throws(
    () =>
      parseClientMessage('{"type":"create_task","projectId":"project-1","permissionMode":"deny"}'),
    /permissionMode 无效/,
  );
  assert.throws(
    () =>
      parseClientMessage('{"type":"create_task","projectId":"project-1","parentTaskId":"task-1"}'),
    /不支持子任务/,
  );
  assert.deepEqual(
    parseClientMessage('{"type":"rename_task","taskId":" task-1 ","title":" 修复构建 "}'),
    {
      type: 'rename_task',
      taskId: 'task-1',
      title: '修复构建',
    },
  );
  assert.throws(
    () => parseClientMessage('{"type":"create_project","name":"Missing root"}'),
    /name 和 rootPath/,
  );
});

test('parseClientMessage validates project archive and rename commands', () => {
  for (const type of ['archive_project', 'restore_project', 'delete_project']) {
    assert.deepEqual(parseClientMessage(JSON.stringify({ type, projectId: ' project-1 ' })), {
      type,
      projectId: 'project-1',
    });
  }
  assert.throws(() => parseClientMessage('{"type":"archive_project"}'), /projectId 不能为空/);
  assert.deepEqual(
    parseClientMessage('{"type":"rename_project","projectId":" project-1 ","name":" 新版 "}'),
    {
      type: 'rename_project',
      projectId: 'project-1',
      name: '新版',
    },
  );
  assert.throws(
    () => parseClientMessage('{"type":"rename_project","projectId":"project-1"}'),
    /projectId 和 name/,
  );
});

test('parseClientMessage accepts optional taskId on task-bound messages', () => {
  assert.deepEqual(parseClientMessage('{"type":"prompt","text":"hello","taskId":" task-1 "}'), {
    type: 'prompt',
    text: 'hello',
    taskId: 'task-1',
  });
  assert.deepEqual(parseClientMessage('{"type":"interrupt","taskId":"task-1"}'), {
    type: 'interrupt',
    taskId: 'task-1',
  });
  assert.deepEqual(
    parseClientMessage(
      '{"type":"permission_response","requestId":"req-1","approved":false,"taskId":"task-1"}',
    ),
    {
      type: 'permission_response',
      requestId: 'req-1',
      approved: false,
      remember: false,
      taskId: 'task-1',
    },
  );
  assert.deepEqual(
    parseClientMessage('{"type":"set_plan_mode","enabled":true,"taskId":"task-1"}'),
    { type: 'set_plan_mode', enabled: true, taskId: 'task-1' },
  );
  // Without taskId the message still parses (routed to the active task).
  assert.deepEqual(parseClientMessage('{"type":"prompt","text":"hi"}'), {
    type: 'prompt',
    text: 'hi',
    taskId: undefined,
  });
});

test('parseClientMessage validates set_task_model', () => {
  assert.deepEqual(
    parseClientMessage(
      '{"type":"set_task_model","taskId":"task-1","providerId":"deepseek","model":"deepseek-v4-pro","reasoningEffort":"high"}',
    ),
    {
      type: 'set_task_model',
      taskId: 'task-1',
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    },
  );
  assert.throws(
    () => parseClientMessage('{"type":"set_task_model","providerId":"deepseek","model":"x"}'),
    /taskId 不能为空/,
  );
  assert.throws(
    () => parseClientMessage('{"type":"set_task_model","taskId":"t","providerId":"deepseek"}'),
    /model 不能为空/,
  );
  assert.throws(
    () =>
      parseClientMessage(
        '{"type":"set_task_model","taskId":"t","providerId":"deepseek","model":"x","reasoningEffort":"ultra"}',
      ),
    /reasoningEffort 格式无效/,
  );
});

test('parseClientMessage validates set_task_rule', () => {
  assert.deepEqual(
    parseClientMessage('{"type":"set_task_rule","taskId":"task-1","tool":"bash","action":"allow"}'),
    { type: 'set_task_rule', taskId: 'task-1', tool: 'bash', action: 'allow' },
  );
  assert.throws(
    () => parseClientMessage('{"type":"set_task_rule","taskId":"t","tool":"bash","action":"deny"}'),
    /action 无效/,
  );
});
