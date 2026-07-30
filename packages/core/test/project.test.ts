import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectManager } from '../src/project';

test('projects and tasks persist with independent workspace roots and sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-projects-'));
  const firstRoot = join(directory, 'alpha');
  const secondRoot = join(directory, 'beta');
  const storagePath = join(directory, 'state', 'projects.json');
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);

  try {
    const manager = new ProjectManager(storagePath);
    await manager.initialize();
    const alpha = await manager.createProject({ name: 'Alpha', rootPath: firstRoot });
    const beta = await manager.createProject({ name: 'Beta', rootPath: secondRoot });
    const alphaTask = await manager.createTask({
      projectId: alpha.id,
      title: '实现登录',
      sessionId: 'session-alpha',
    });
    await manager.createTask({
      projectId: beta.id,
      title: '修复测试',
      sessionId: 'session-beta',
    });
    await manager.attachSession(alphaTask.id, 'session-alpha-updated');

    const restored = new ProjectManager(storagePath);
    await restored.initialize();
    assert.equal(restored.listProjects().length, 2);
    assert.equal(restored.listTasks(alpha.id).length, 1);
    assert.equal(restored.listTasks(beta.id).length, 1);
    assert.equal(restored.getTask(alphaTask.id)?.sessionId, 'session-alpha-updated');
    assert.notEqual(
      restored.getProject(alpha.id)?.rootPath,
      restored.getProject(beta.id)?.rootPath,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('project roots must exist and cannot be registered twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-project-validation-'));
  const manager = new ProjectManager(join(directory, 'projects.json'));
  await manager.initialize();
  try {
    await assert.rejects(
      manager.createProject({ name: 'Missing', rootPath: join(directory, 'missing') }),
      /不存在/,
    );
    await manager.createProject({ name: 'First', rootPath: directory });
    await assert.rejects(
      manager.createProject({ name: 'Duplicate', rootPath: directory }),
      /已经属于项目/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
