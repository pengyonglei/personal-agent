import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createLogger, generateId } from '@personal-agent/shared';

const log = createLogger('project');
const DEFAULT_PROJECT_FILE = resolve(homedir(), '.personal-agent', 'projects.json');

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectTask {
  id: string;
  projectId: string;
  title: string;
  sessionId?: string;
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

interface SerializedProjectStore {
  version: 1;
  projects: Array<
    Omit<Project, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }
  >;
  tasks: Array<
    Omit<ProjectTask, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }
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
      for (const project of raw.projects ?? []) {
        this.projects.set(project.id, {
          ...project,
          createdAt: new Date(project.createdAt),
          updatedAt: new Date(project.updatedAt),
        });
      }
      for (const task of raw.tasks ?? []) {
        if (!this.projects.has(task.projectId)) continue;
        this.tasks.set(task.id, {
          ...task,
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
    const existing = this.listProjects().find((project) =>
      samePath(project.rootPath, canonicalRoot),
    );
    if (existing) return existing;
    return this.createProject({
      name: name?.trim() || canonicalRoot.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace',
      rootPath: canonicalRoot,
    });
  }

  async createProject(input: { name: string; rootPath: string }): Promise<Project> {
    const name = validateText(input.name, '项目名称', 100);
    const rootPath = await validateRootPath(input.rootPath);
    const duplicate = this.listProjects().find((project) => samePath(project.rootPath, rootPath));
    if (duplicate) {
      throw new Error(`该目录已经属于项目“${duplicate.name}”`);
    }
    const now = new Date();
    const project: Project = {
      id: `project-${generateId()}`,
      name,
      rootPath,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    await this.persist();
    return cloneProject(project);
  }

  listProjects(): Project[] {
    return [...this.projects.values()]
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .map(cloneProject);
  }

  getProject(projectId: string): Project | null {
    const project = this.projects.get(projectId);
    return project ? cloneProject(project) : null;
  }

  async createTask(input: {
    projectId: string;
    title: string;
    sessionId?: string;
  }): Promise<ProjectTask> {
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error(`项目不存在: ${input.projectId}`);
    const now = new Date();
    const task: ProjectTask = {
      id: `task-${generateId()}`,
      projectId: project.id,
      title: validateText(input.title, '任务标题', 200),
      sessionId: input.sessionId,
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
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
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

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
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
