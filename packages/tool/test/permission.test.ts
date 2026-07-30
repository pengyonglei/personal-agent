import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseTool, PermissionManager, Sandbox, ToolExecutor, ToolRegistry } from '../src/index';

test('explicit approval bypasses one permission check without weakening defaults', async () => {
  let calls = 0;
  const tool = new (class extends BaseTool {
    readonly name = 'dangerous_action';
    readonly description = 'A permission-gated action';
    readonly category = 'utility';
    readonly requiresPermission = true;
    readonly inputSchema = { type: 'object', properties: {} };
    async execute() {
      calls++;
      return { success: true, content: 'done' };
    }
  })();
  const registry = new ToolRegistry();
  registry.register(tool);
  const executor = new ToolExecutor(registry, new PermissionManager(), new Sandbox());
  const context = { sessionId: 'test', workingDirectory: process.cwd() };

  const pending = await executor.execute(tool.name, {}, context);
  assert.match(pending.error ?? '', /NEEDS_PERMISSION/);
  assert.equal(calls, 0);

  const approved = await executor.executeWithPermission(tool.name, {}, context, true);
  assert.equal(approved.success, true);
  assert.equal(calls, 1);

  const pendingAgain = await executor.execute(tool.name, {}, context);
  assert.match(pendingAgain.error ?? '', /NEEDS_PERMISSION/);
});

test('permission rules support qualified prefix wildcards', () => {
  const permissions = new PermissionManager();
  permissions.addRule({
    tool: 'mcp__docs__*',
    action: 'allow',
    scope: 'session',
  });
  assert.equal(permissions.check('mcp__docs__search'), 'allow');
  assert.equal(permissions.check('mcp__other__search'), 'ask');
});

test('restricted sandbox permits the workspace but rejects sibling prefixes', () => {
  const workspace = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';
  const sibling =
    process.platform === 'win32' ? 'C:\\work\\repo-secret\\file.txt' : '/work/repo-secret/file.txt';
  const inside =
    process.platform === 'win32' ? 'C:\\work\\repo\\src\\index.ts' : '/work/repo/src/index.ts';
  const sandbox = new Sandbox({
    restrictPaths: true,
    allowedPaths: [],
    deniedPaths: [],
    deniedCommands: [],
    maxFileSize: 1024,
    shellTimeout: 1000,
    webFetchTimeout: 1000,
  });
  assert.equal(sandbox.isPathAllowed(inside, workspace), true);
  assert.equal(sandbox.isPathAllowed(sibling, workspace), false);
});
