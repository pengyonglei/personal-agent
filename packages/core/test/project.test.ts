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
    await manager.renameTask(alphaTask.id, '实现登录与注册');

    const restored = new ProjectManager(storagePath);
    await restored.initialize();
    assert.equal(restored.listProjects().length, 2);
    assert.equal(restored.listTasks(alpha.id).length, 1);
    assert.equal(restored.listTasks(beta.id).length, 1);
    assert.equal(restored.getTask(alphaTask.id)?.sessionId, 'session-alpha-updated');
    assert.equal(restored.getTask(alphaTask.id)?.title, '实现登录与注册');
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

test('projects can be archived, restored, renamed, and deleted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-project-lifecycle-'));
  const firstRoot = join(directory, 'alpha');
  const secondRoot = join(directory, 'beta');
  const storagePath = join(directory, 'state', 'projects.json');
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);

  try {
    const manager = new ProjectManager(storagePath);
    await manager.initialize();
    const alpha = await manager.createProject({ name: 'Alpha', rootPath: firstRoot });
    const beta = await manager.createProject({ name: 'Beta', rootPath: secondRoot });
    await manager.createTask({ projectId: alpha.id, title: 'Alpha 任务' });
    await manager.createTask({ projectId: beta.id, title: 'Beta 任务' });

    // New projects are active by default.
    assert.equal(alpha.archived, false);
    assert.deepEqual(
      manager
        .listProjects()
        .map((project) => project.id)
        .sort(),
      [alpha.id, beta.id].sort(),
    );

    // Archiving hides the project from the default listing.
    await manager.archiveProject(alpha.id);
    assert.deepEqual(
      manager.listProjects().map((project) => project.id),
      [beta.id],
    );
    assert.deepEqual(
      manager
        .listProjects({ includeArchived: true })
        .map((project) => project.id)
        .sort(),
      [alpha.id, beta.id].sort(),
    );
    assert.equal(manager.getProject(alpha.id)?.archived, true);

    // Restoring brings it back.
    await manager.restoreProject(alpha.id);
    assert.deepEqual(
      manager
        .listProjects()
        .map((project) => project.id)
        .sort(),
      [alpha.id, beta.id].sort(),
    );

    // Renaming updates the stored name.
    await manager.renameProject(alpha.id, 'Alpha 2');
    assert.equal(manager.getProject(alpha.id)?.name, 'Alpha 2');

    // Deleting removes the project and all of its tasks.
    await manager.deleteProject(alpha.id);
    assert.equal(manager.getProject(alpha.id), null);
    assert.equal(manager.getTask('task-missing'), null);
    assert.deepEqual(
      manager.listProjects().map((project) => project.id),
      [beta.id],
    );

    // The lifecycle survives a reload.
    const restored = new ProjectManager(storagePath);
    await restored.initialize();
    assert.equal(restored.getProject(beta.id)?.archived, false);
    assert.equal(restored.listProjects().length, 1);
    assert.equal(restored.listTasks(beta.id).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('tasks are direct project children and archive independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-flat-tasks-'));
  const root = join(directory, 'workspace');
  const storagePath = join(directory, 'projects.json');
  await mkdir(root);

  try {
    const manager = new ProjectManager(storagePath);
    await manager.initialize();
    const project = await manager.createProject({ name: 'Flat', rootPath: root });
    const first = await manager.createTask({ projectId: project.id, title: '任务 A' });
    const second = await manager.createTask({ projectId: project.id, title: '任务 B' });

    assert.equal(manager.listTasks(project.id).length, 2);
    await manager.archiveTask(first.id);
    assert.equal(manager.listTasks(project.id).length, 1);
    assert.equal(manager.getTask(second.id)?.status, 'active');

    const restored = new ProjectManager(storagePath);
    await restored.initialize();
    assert.equal(restored.listTasks(project.id).length, 1);
    assert.equal(restored.listTasks(project.id)[0].id, second.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('task plan mode persists across reloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-project-planmode-'));
  const root = join(directory, 'workspace');
  const storagePath = join(directory, 'projects.json');
  await mkdir(root);
  try {
    const manager = new ProjectManager(storagePath);
    await manager.initialize();
    const project = await manager.createProject({ name: 'PlanMode', rootPath: root });
    const task = await manager.createTask({
      projectId: project.id,
      title: '计划模式任务',
      planMode: true,
    });
    assert.equal(manager.getTask(task.id)?.planMode, true);

    await manager.setTaskPlanMode(task.id, false);
    assert.equal(manager.getTask(task.id)?.planMode, undefined);

    await manager.setTaskPlanMode(task.id, true);
    const restored = new ProjectManager(storagePath);
    await restored.initialize();
    assert.equal(restored.getTask(task.id)?.planMode, true);

    // 未设置的旧任务记录默认为 undefined（不开启）
    const plainTask = await restored.createTask({ projectId: project.id, title: '普通任务' });
    assert.equal(restored.getTask(plainTask.id)?.planMode, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
