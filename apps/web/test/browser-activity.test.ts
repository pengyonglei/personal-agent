import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolResult } from '@personal-agent/shared';
import {
  appendBrowserActivity,
  browserSessionState,
  describeBrowserAction,
  isBrowserTool,
  parseBrowserSnapshot,
  resolveBrowserSessionId,
  screenshotFromResult,
  updateBrowserActivity,
  type BrowserActivityItem,
} from '../client/src/browser-activity';

test('resolveBrowserSessionId falls back to the persisted task session during view restore', () => {
  assert.equal(resolveBrowserSessionId('live-session', 'task-session'), 'live-session');
  assert.equal(resolveBrowserSessionId(undefined, 'task-session'), 'task-session');
  assert.equal(resolveBrowserSessionId('  ', ' task-session '), 'task-session');
  assert.equal(resolveBrowserSessionId(undefined, undefined), undefined);
});

test('isBrowserTool 识别浏览器相关工具', () => {
  for (const name of [
    'browser_open',
    'browser_act',
    'browser_snapshot',
    'browser_screenshot',
    'browser_close',
    'frontend_validate',
  ]) {
    assert.equal(isBrowserTool(name), true, name);
  }
  assert.equal(isBrowserTool('bash'), false);
  assert.equal(isBrowserTool('read_file'), false);
});

test('describeBrowserAction: browser_open 带与不带 url', () => {
  assert.equal(describeBrowserAction('browser_open', {}), '打开浏览器');
  assert.equal(
    describeBrowserAction('browser_open', { url: 'http://localhost:5173/' }),
    '打开浏览器：http://localhost:5173/',
  );
});

test('describeBrowserAction: browser_act 各类动作', () => {
  assert.equal(
    describeBrowserAction('browser_act', { action: 'click', role: 'button', name: '登录' }),
    '点击 role=button "登录"',
  );
  assert.equal(
    describeBrowserAction('browser_act', { action: 'click', testId: 'submit-btn' }),
    '点击 [data-testid="submit-btn"]',
  );
  assert.equal(
    describeBrowserAction('browser_act', { action: 'fill', text: '搜索', value: 'hello' }),
    '输入 "hello" 到 文本 "搜索"',
  );
  assert.equal(
    describeBrowserAction('browser_act', { action: 'press', selector: 'input', key: 'Enter' }),
    '在 input 按键 Enter',
  );
  assert.equal(
    describeBrowserAction('browser_act', { action: 'check', testId: 'agree' }),
    '勾选 [data-testid="agree"]',
  );
  assert.equal(
    describeBrowserAction('browser_act', { action: 'select', role: 'combobox', value: 'a' }),
    '在 role=combobox 选择 "a"',
  );
  assert.equal(describeBrowserAction('browser_act', { action: 'wait', timeoutMs: 800 }), '等待 800 ms');
  assert.equal(
    describeBrowserAction('browser_act', { action: 'unknown', selector: '#x' }),
    '执行 unknown #x',
  );
});

test('describeBrowserAction: snapshot/screenshot/close/validate', () => {
  assert.equal(describeBrowserAction('browser_snapshot', {}), '获取页面快照');
  assert.equal(describeBrowserAction('browser_screenshot', {}), '截图');
  assert.equal(
    describeBrowserAction('browser_screenshot', { name: 'landing' }),
    '截图：landing.png',
  );
  assert.equal(describeBrowserAction('browser_close', {}), '关闭浏览器');
  assert.equal(describeBrowserAction('frontend_validate', {}), '前端验证（quick）');
  assert.equal(describeBrowserAction('frontend_validate', { profile: 'full' }), '前端验证（full）');
});

test('parseBrowserSnapshot 解析合法快照并截断文本', () => {
  const parsed = parseBrowserSnapshot(
    JSON.stringify({ url: 'http://localhost:3000/', title: 'Home', text: 'hello world' }),
  );
  assert.deepEqual(parsed, { url: 'http://localhost:3000/', title: 'Home', text: 'hello world' });

  const huge = parseBrowserSnapshot(JSON.stringify({ url: 'http://x', text: 'a'.repeat(10_000) }));
  assert.equal(huge?.text?.length, 4000);
});

test('parseBrowserSnapshot 拒绝非法内容', () => {
  assert.equal(parseBrowserSnapshot('Browser session closed.'), null);
  assert.equal(parseBrowserSnapshot(''), null);
  assert.equal(parseBrowserSnapshot('{invalid json'), null);
  assert.equal(parseBrowserSnapshot('{"noUrl": true}'), null);
});

test('screenshotFromResult 提取截图工件引用', () => {
  const result: ToolResult = {
    success: true,
    content: 'Screenshot captured: landing.png',
    metadata: {
      duration: 0,
      artifacts: [
        { id: 'landing.png', kind: 'screenshot', name: 'landing.png', mimeType: 'image/png', size: 1 },
      ],
      validation: {
        runId: 'run-1',
        projectHash: 'abc',
        profile: 'quick',
        status: 'passed',
        summary: '',
        durationMs: 0,
        steps: [],
        issues: [],
        vision: { status: 'skipped', reason: '' },
      },
    },
  };
  assert.deepEqual(screenshotFromResult(result), {
    projectHash: 'abc',
    runId: 'run-1',
    artifactId: 'landing.png',
    name: 'landing.png',
  });
});

test('screenshotFromResult 缺少 validation 信息时返回 undefined', () => {
  const result: ToolResult = {
    success: true,
    content: 'ok',
    metadata: {
      duration: 0,
      artifacts: [
        { id: 'a.png', kind: 'screenshot', name: 'a.png', mimeType: 'image/png', size: 1 },
      ],
    },
  };
  assert.equal(screenshotFromResult(result), undefined);
});

test('browserSessionState 推导打开/关闭与当前 URL', () => {
  const activity: BrowserActivityItem[] = [
    { id: '1', toolName: 'browser_open', status: 'success', time: '10:00:00', summary: '打开浏览器', url: 'http://localhost:3000/' },
    { id: '2', toolName: 'browser_act', status: 'success', time: '10:00:01', summary: '点击', url: 'http://localhost:3000/login' },
  ];
  assert.deepEqual(browserSessionState(activity), {
    open: true,
    url: 'http://localhost:3000/login',
  });

  const closed: BrowserActivityItem[] = [
    ...activity,
    { id: '3', toolName: 'browser_close', status: 'success', time: '10:00:02', summary: '关闭浏览器' },
  ];
  assert.deepEqual(browserSessionState(closed), { open: false, url: undefined });

  // running 中的 open 不影响状态（须等成功）
  const running: BrowserActivityItem[] = [
    { id: '1', toolName: 'browser_open', status: 'running', time: '10:00:00', summary: '打开浏览器', url: 'http://localhost:3000/' },
  ];
  assert.deepEqual(browserSessionState(running), { open: false, url: undefined });
});

test('appendBrowserActivity 按 id 更新并裁剪', () => {
  const base: BrowserActivityItem = {
    id: 'call-1',
    toolName: 'browser_open',
    status: 'running',
    time: '10:00:00',
    summary: '打开浏览器',
  };
  let list = appendBrowserActivity([], base);
  assert.equal(list.length, 1);
  list = updateBrowserActivity(list, 'call-1', { status: 'success', url: 'http://x' });
  assert.equal(list[0].status, 'success');
  assert.equal(list[0].url, 'http://x');
  // 不存在的 id 保持原样
  list = updateBrowserActivity(list, 'nope', { status: 'failed' });
  assert.equal(list[0].status, 'success');
});
