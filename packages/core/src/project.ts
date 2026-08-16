import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createLogger, generateId, type ReasoningEffort } from '@personal-agent/shared';

const log = createLogger('project');
const DEFAULT_PROJECT_FILE = resolve(homedir(), '.personal-agent', 'projects.json');

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  archived: boolean;
  pinned: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectTaskPermissionMode = 'allow' | 'ask' | 'approval';

export interface ProjectTask {
  id: string;
  projectId: string;
  title: string;
  sessionId?: string;
  /** 任务级模型覆盖（'provider:model'），刷新/重启后恢复任务模型用。 */
  model?: string;
  /** 任务级思考强度覆盖，与 model 一样随任务持久化，刷新/重启后恢复。 */
  reasoningEffort?: ReasoningEffort;
  /** 任务级计划模式开关，刷新/重启后恢复计划模式用。 */
  planMode?: boolean;
  permissionMode: ProjectTaskPermissionMode;
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

interface SerializedProjectStore {
  version: 1;
  projects: Array<
    Omit<Project, 'createdAt' | 'updatedAt' | 'pinned' | 'sortOrder'> & {
      pinned?: boolean;
      sortOrder?: number;
      createdAt: string;
      updatedAt: string;
    }
  >;
  tasks: Array<
    Omit<ProjectTask, 'createdAt' | 'updatedAt'> & {
      parentTaskId?: string;
      createdAt: string;
      updatedAt: string;
    }
  >;
}

export class ProjectManager {
  private projects = new Map<string, Project>();
  private tasks = new Map<string, ProjectTask>();
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storagePath = DEFAULT_PROJECT_FILE) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.storagePath), { recursive: true });
    if (!existsSync(this.storagePath)) return;
    try {
      const raw = JSON.parse(await readFile(this.storagePath, 'utf-8')) as SerializedProjectStore;
      this.projects.clear();
      this.tasks.clear();
      const legacyProjectOrder = new Map(
        [...(raw.projects ?? [])]
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
          .map((project, index) => [project.id, index]),
      );
      for (const project of raw.projects ?? []) {
        this.projects.set(project.id, {
          ...project,
          archived: project.archived === true,
          pinned: project.pinned === true,
          sortOrder: Number.isFinite(project.sortOrder)
            ? (project.sortOrder as number)
            : (legacyProjectOrder.get(project.id) ?? 0),
          createdAt: new Date(project.createdAt),
          updatedAt: new Date(project.updatedAt),
        });
      }
      for (const task of raw.tasks ?? []) {
        if (!this.projects.has(task.projectId)) continue;
        this.tasks.set(task.id, {
          id: task.id,
          projectId: task.projectId,
          title: task.title,
          sessionId: task.sessionId,
          model: task.model || undefined,
          reasoningEffort: task.reasoningEffort || undefined,
          planMode: task.planMode === true || undefined,
          permissionMode: normalizePermissionMode(task.permissionMode),
          status: task.status === 'archived' ? 'archived' : 'active',
          createdAt: new Date(task.createdAt),
          updatedAt: new Date(task.updatedAt),
        });
      }
    } catch (error) {
      log.warn(`Could not load project store: ${formatError(error)}`);
    }
  }

  async ensureDefaultProject(rootPath: string, name?: string): Promise<Project> {
    const canonicalRoot = await validateRootPath(rootPath);
    const existing = this.listProjects({ includeArchived: true }).find((project) =>
      samePath(project.rootPath, canonicalRoot),
    );
    if (existing) return existing;
    return this.createProject({
      name: name?.trim() || canonicalRoot.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace',
      rootPath: canonicalRoot,
    });
  }

  /**
   * 从磁盘重新加载项目与任务数据（用于「刷新项目和任务」等场景）：
   * 等待尚未落盘的写入完成后，重新读取存储文件替换内存中的数据，
   * 从而拾取其他进程/外部编辑对存储文件所做的变更。
   * 若文件缺失或解析失败则保留当前内存数据，不导致列表被清空。
   */
  async reload(): Promise<void> {
    await this.saveQueue;
    await this.initialize();
  }

  async createProject(input: { name: string; rootPath: string }): Promise<Project> {
    const name = validateText(input.name, '项目名称', 100);
    const rootPath = await validateRootPath(input.rootPath);
    const duplicate = this.listProjects({ includeArchived: true }).find((project) =>
      samePath(project.rootPath, rootPath),
    );
    if (duplicate) {
      throw new Error(`该目录已经属于项目“${duplicate.name}”`);
    }
    const now = new Date();
    const project: Project = {
      id: `project-${generateId()}`,
      name,
      rootPath,
      archived: false,
      pinned: false,
      sortOrder: this.nextProjectSortOrder(false),
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    await this.persist();
    return cloneProject(project);
  }

  listProjects(options: { includeArchived?: boolean } = {}): Project[] {
    return [...this.projects.values()]
      .filter((project) => options.includeArchived || !project.archived)
      .sort(compareProjects)
      .map(cloneProject);
  }

  getProject(projectId: string): Project | null {
    const project = this.projects.get(projectId);
    return project ? cloneProject(project) : null;
  }

  async archiveProject(projectId: string): Promise<Project> {
    const project = this.requireProject(projectId);
    if (project.archived) return cloneProject(project);
    project.archived = true;
    project.pinned = false;
    project.updatedAt = new Date();
    await this.persist();
    return cloneProject(project);
  }

  async restoreProject(projectId: string): Promise<Project> {
    const project = this.requireProject(projectId);
    if (!project.archived) return cloneProject(project);
    project.archived = false;
    project.pinned = false;
    project.sortOrder = this.nextProjectSortOrder(false);
    project.updatedAt = new Date();
    await this.persist();
    return cloneProject(project);
  }

  async renameProject(projectId: string, name: string): Promise<Project> {
    const project = this.requireProject(projectId);
    project.name = validateText(name, '项目名称', 100);
    project.updatedAt = new Date();
    await this.persist();
    return cloneProject(project);
  }

  async setProjectPinned(projectId: string, pinned: boolean): Promise<Project> {
    const project = this.requireProject(projectId);
    if (project.archived) throw new Error('归档项目不能置顶');
    if (project.pinned === pinned) return cloneProject(project);
    project.pinned = pinned;
    project.sortOrder = this.nextProjectSortOrder(pinned);
    project.updatedAt = new Date();
    await this.persist();
    return cloneProject(project);
  }

  async reorderProjects(projectIds: string[], pinned: boolean): Promise<Project[]> {
    const group = [...this.projects.values()].filter(
      (project) => !project.archived && project.pinned === pinned,
    );
    const uniqueProjectIds = new Set(projectIds);
    if (
      uniqueProjectIds.size !== projectIds.length ||
      projectIds.length !== group.length ||
      group.some((project) => !uniqueProjectIds.has(project.id))
    ) {
      throw new Error('项目排序列表与当前项目不一致，请刷新后重试');
    }

    const now = new Date();
    for (const [sortOrder, projectId] of projectIds.entries()) {
      const project = this.requireProject(projectId);
      project.sortOrder = sortOrder;
      project.updatedAt = now;
    }
    await this.persist();
    return projectIds.map((projectId) => cloneProject(this.requireProject(projectId)));
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = this.requireProject(projectId);
    for (const [taskId, task] of this.tasks) {
      if (task.projectId === project.id) this.tasks.delete(taskId);
    }
    this.projects.delete(project.id);
    await this.persist();
  }

  private requireProject(projectId: string): Project {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    return project;
  }

  private nextProjectSortOrder(pinned: boolean): number {
    const sortOrders = [...this.projects.values()]
      .filter((project) => !project.archived && project.pinned === pinned)
      .map((project) => project.sortOrder)
      .filter(Number.isFinite);
    return sortOrders.length > 0 ? Math.min(...sortOrders) - 1 : 0;
  }

  async createTask(input: {
    projectId: string;
    title: string;
    sessionId?: string;
    permissionMode?: ProjectTaskPermissionMode;
    planMode?: boolean;
  }): Promise<ProjectTask> {
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error(`项目不存在: ${input.projectId}`);
    const now = new Date();
    const task: ProjectTask = {
      id: `task-${generateId()}`,
      projectId: project.id,
      title: validateText(input.title, '任务标题', 200),
      sessionId: input.sessionId,
      planMode: input.planMode === true || undefined,
      permissionMode: normalizePermissionMode(input.permissionMode ?? 'ask'),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    project.updatedAt = now;
    await this.persist();
    return cloneTask(task);
  }

  listTasks(projectId: string, options: { includeArchived?: boolean } = {}): ProjectTask[] {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.projectId === projectId && (options.includeArchived || task.status === 'active'),
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(cloneTask);
  }

  getTask(taskId: string): ProjectTask | null {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : null;
  }

  async attachSession(taskId: string, sessionId: string): Promise<ProjectTask> {
    const task = this.requireTask(taskId);
    task.sessionId = sessionId;
    task.updatedAt = new Date();
    const project = this.projects.get(task.projectId);
    if (project) project.updatedAt = task.updatedAt;
    await this.persist();
    return cloneTask(task);
  }

  async renameTask(taskId: string, title: string): Promise<ProjectTask> {
    const task = this.requireTask(taskId);
    task.title = validateText(title, '任务标题', 200);
    task.updatedAt = new Date();
    const project = this.projects.get(task.projectId);
    if (project) project.updatedAt = task.updatedAt;
    await this.persist();
    return cloneTask(task);
  }

  async setTaskPermissionMode(
    taskId: string,
    permissionMode: ProjectTaskPermissionMode,
  ): Promise<ProjectTask> {
    const task = this.requireTask(taskId);
    task.permissionMode = normalizePermissionMode(permissionMode);
    await this.persist();
    return cloneTask(task);
  }

  async setTaskPlanMode(taskId: string, planMode: boolean): Promise<ProjectTask> {
    const task = this.requireTask(taskId);
    task.planMode = planMode === true || undefined;
    await this.persist();
    return cloneTask(task);
  }

  /**
   * 持久化任务级模型与思考强度覆盖。model 或 reasoningEffort 传 undefined
   * 表示清除对应覆盖（任务回退全局默认 / 模型默认档）。
   */
  async setTaskModel(
    taskId: string,
    model: string | undefined,
    reasoningEffort?: ReasoningEffort | undefined,
  ): Promise<ProjectTask> {
    const task = this.requireTask(taskId);
    task.model = model ? model.trim() || undefined : undefined;
    task.reasoningEffort = reasoningEffort || undefined;
    task.updatedAt = new Date();
    const project = this.projects.get(task.projectId);
    if (project) project.updatedAt = task.updatedAt;
    await this.persist();
    return cloneTask(task);
  }

  async touchTask(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    task.updatedAt = new Date();
    const project = this.projects.get(task.projectId);
    if (project) project.updatedAt = task.updatedAt;
    await this.persist();
  }

  async archiveTask(taskId: string): Promise<ProjectTask> {
    const task = this.requireTask(taskId);
    task.status = 'archived';
    task.updatedAt = new Date();
    await this.persist();
    return cloneTask(task);
  }

  private requireTask(taskId: string): ProjectTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    return task;
  }

  private persist(): Promise<void> {
    const snapshot: SerializedProjectStore = {
      version: 1,
      projects: [...this.projects.values()].map((project) => ({
        ...project,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      })),
      tasks: [...this.tasks.values()].map((task) => ({
        ...task,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
      })),
    };
    this.saveQueue = this.saveQueue.then(async () => {
      await writeFile(this.storagePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    });
    return this.saveQueue;
  }
}

async function validateRootPath(rootPath: string): Promise<string> {
  if (!rootPath?.trim()) throw new Error('本地根目录不能为空');
  const absolutePath = resolve(rootPath.trim());
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    throw new Error(`本地根目录不存在: ${absolutePath}`);
  }
  if (!info.isDirectory()) throw new Error(`路径不是目录: ${absolutePath}`);
  return realpath(absolutePath);
}

function validateText(value: string, label: string, maxLength: number): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return normalized;
}

function normalizePermissionMode(value: unknown): ProjectTaskPermissionMode {
  return value === 'allow' || value === 'approval' ? value : 'ask';
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function compareProjects(left: Project, right: Project): number {
  if (left.archived !== right.archived) return left.archived ? 1 : -1;
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  return right.createdAt.getTime() - left.createdAt.getTime();
}

function cloneProject(project: Project): Project {
  return {
    ...project,
    createdAt: new Date(project.createdAt),
    updatedAt: new Date(project.updatedAt),
  };
}

function cloneTask(task: ProjectTask): ProjectTask {
  return {
    ...task,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
