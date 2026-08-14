import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('projects can be pinned and reordered with persistent group ordering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-project-order-'));
  const roots = [join(directory, 'alpha'), join(directory, 'beta'), join(directory, 'gamma')];
  const storagePath = join(directory, 'state', 'projects.json');
  await Promise.all(roots.map((root) => mkdir(root)));

  try {
    const manager = new ProjectManager(storagePath);
    await manager.initialize();
    const alpha = await manager.createProject({ name: 'Alpha', rootPath: roots[0]! });
    const beta = await manager.createProject({ name: 'Beta', rootPath: roots[1]! });
    const gamma = await manager.createProject({ name: 'Gamma', rootPath: roots[2]! });

    assert.deepEqual(
      manager.listProjects().map((project) => project.id),
      [gamma.id, beta.id, alpha.id],
    );

    await manager.setProjectPinned(alpha.id, true);
    await manager.setProjectPinned(gamma.id, true);
    assert.deepEqual(
      manager.listProjects().map((project) => project.id),
      [gamma.id, alpha.id, beta.id],
    );

    await manager.reorderProjects([alpha.id, gamma.id], true);
    assert.deepEqual(
      manager.listProjects().map((project) => project.id),
      [alpha.id, gamma.id, beta.id],
    );
    await assert.rejects(manager.reorderProjects([gamma.id], true), /排序列表与当前项目不一致/);

    const restored = new ProjectManager(storagePath);
    await restored.initialize();
    assert.deepEqual(
      restored.listProjects().map((project) => ({ id: project.id, pinned: project.pinned })),
      [
        { id: alpha.id, pinned: true },
        { id: gamma.id, pinned: true },
        { id: beta.id, pinned: false },
      ],
    );

    await restored.archiveProject(alpha.id);
    assert.equal(restored.getProject(alpha.id)?.pinned, false);
    await restored.restoreProject(alpha.id);
    assert.deepEqual(
      restored.listProjects().map((project) => project.id),
      [gamma.id, alpha.id, beta.id],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy project stores keep their newest-first order when sorting fields are absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-project-order-migration-'));
  const storagePath = join(directory, 'projects.json');

  try {
    await writeFile(
      storagePath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: 'project-oldest',
            name: 'Oldest',
            rootPath: directory,
            archived: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          },
          {
            id: 'project-newest',
            name: 'Newest',
            rootPath: join(directory, 'newest'),
            archived: false,
            createdAt: '2025-02-01T00:00:00.000Z',
            updatedAt: '2025-02-01T00:00:00.000Z',
          },
        ],
        tasks: [],
      }),
      'utf-8',
    );

    const manager = new ProjectManager(storagePath);
    await manager.initialize();
    assert.deepEqual(
      manager.listProjects().map((project) => ({ id: project.id, pinned: project.pinned })),
      [
        { id: 'project-newest', pinned: false },
        { id: 'project-oldest', pinned: false },
      ],
    );
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

test('reload picks up external changes written to the storage file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-project-reload-'));
  const root = join(directory, 'workspace');
  const storagePath = join(directory, 'projects.json');
  await mkdir(root);
  try {
    const manager = new ProjectManager(storagePath);
    await manager.initialize();
    const project = await manager.createProject({ name: '原始项目', rootPath: root });
    await manager.createTask({ projectId: project.id, title: '原始任务' });

    // 模拟其他进程/外部编辑直接修改存储文件：新增一个项目。
    const raw = JSON.parse(await readFile(storagePath, 'utf8')) as {
      projects: Array<Record<string, unknown>>;
    };
    raw.projects.push({
      id: 'project-external',
      name: '外部新增项目',
      rootPath: root,
      archived: false,
      pinned: false,
      sortOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await writeFile(storagePath, JSON.stringify(raw, null, 2), 'utf8');

    // 刷新前内存里看不到外部项目
    assert.equal(
      manager
        .listProjects({ includeArchived: true })
        .some((candidate) => candidate.id === 'project-external'),
      false,
      '未刷新前不应包含外部新增项目',
    );

    await manager.reload();

    const names = manager.listProjects({ includeArchived: true }).map((candidate) => candidate.name);
    assert.ok(names.includes('外部新增项目'), 'reload 后应读取到外部新增的项目');
    assert.ok(names.includes('原始项目'), 'reload 后原有项目应保留');
    assert.ok(
      manager.listTasks(project.id).some((task) => task.title === '原始任务'),
      'reload 后原有任务应保留',
    );

    // 文件缺失/损坏时 reload 不应清空内存数据
    await rm(storagePath, { force: true });
    await manager.reload();
    assert.ok(
      manager.listProjects({ includeArchived: true }).length > 0,
      '存储文件缺失时 reload 应保留当前内存数据',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
