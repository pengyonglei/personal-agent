import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Tool, ToolRegistry } from '@personal-agent/tool';
import { createLogger } from '@personal-agent/shared';
import type { JSONSchema } from '@personal-agent/shared';

const log = createLogger('plugin');

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  tools?: PluginToolDef[];
  skills?: PluginSkillDef[];
  hooks?: PluginHookDef[];
  mcpServers?: PluginMCPServerDef[];
  commands?: PluginCommandDef[];
}

export interface PluginToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  entry: string; // relative path to tool module
  category?: Tool['category'];
  requiresPermission?: boolean;
  isDangerous?: boolean;
  canBeUsedInSubAgent?: boolean;
}

export interface PluginSkillDef {
  name: string;
  description: string;
  file: string; // relative path to skill markdown file
  triggers?: string[];
}

export interface PluginHookDef {
  event: HookEvent;
  entry: string; // relative path to hook handler
}

export interface PluginMCPServerDef {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PluginCommandDef {
  name: string; // e.g., "/my-command"
  description: string;
  entry: string;
}

export type HookEvent =
  'on_session_start' | 'on_session_end' | 'on_tool_execute' | 'on_tool_result' | 'on_user_input';

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export interface Skill {
  name: string;
  description: string;
  content: string; // Markdown content (instructions for the agent)
  triggers?: string[]; // Keywords that auto-trigger this skill
  sourcePath: string; // Where this skill was loaded from
}

// ---------------------------------------------------------------------------
// Loaded plugin
// ---------------------------------------------------------------------------

export interface LoadedPlugin {
  manifest: PluginManifest;
  sourcePath: string;
  tools: Tool[];
  skills: Skill[];
  hooks: PluginHookDef[];
  commands: PluginCommandDef[];
  mcpConfigs: PluginMCPServerDef[];
}

// ---------------------------------------------------------------------------
// Plugin loader
// ---------------------------------------------------------------------------

const PLUGIN_SEARCH_PATHS = [
  resolve(homedir(), '.personal-agent', 'plugins'),
  resolve(process.cwd(), '.personal-agent', 'plugins'),
];

/**
 * personal-agent 技能目录（Claude Code / Codex 兼容的 SKILL.md 格式）。
 * 默认仅扫描 `~/.personal-agent/skills`，可通过 `skills.paths` 配置扩展。
 * 每个目录包含 `<skill-name>/SKILL.md` 文件。
 */
const STANDARD_SKILL_SEARCH_PATHS = [
  resolve(homedir(), '.personal-agent', 'skills'),
];

export class PluginLoader {
  private loadedPlugins: LoadedPlugin[] = [];
  private standaloneSkills: Skill[] = [];
  private customPaths: string[] = [];
  private disabled = new Set<string>();
  private discoveredSources = new Map<string, string>();
  private hookHandlers = new Map<string, PluginHookHandler>();

  constructor(paths?: string[], options: { disabled?: string[] } = {}) {
    if (paths) {
      this.customPaths = paths;
    }
    this.disabled = new Set(options.disabled ?? []);
  }

  /**
   * Discover all plugins from the standard search paths.
   */
  async discoverPlugins(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];
    const searchPaths = [...this.customPaths, ...PLUGIN_SEARCH_PATHS];
    this.discoveredSources.clear();

    for (const basePath of searchPaths) {
      if (!existsSync(basePath)) continue;

      try {
        const entries = readdirSync(basePath);
        for (const entry of entries) {
          const fullPath = join(basePath, entry);
          if (!statSync(fullPath).isDirectory()) continue;

          const manifestPath = join(fullPath, 'plugin.json');
          if (!existsSync(manifestPath)) continue;

          try {
            const raw = readFileSync(manifestPath, 'utf-8');
            const manifest = JSON.parse(raw) as PluginManifest;

            // Validate required fields
            if (!manifest.name || !manifest.version) {
              log.warn(`Skipping invalid plugin at ${fullPath}: missing name/version`);
              continue;
            }

            if (this.discoveredSources.has(manifest.name)) {
              log.warn(`Skipping duplicate plugin '${manifest.name}' at ${fullPath}`);
              continue;
            }
            this.discoveredSources.set(manifest.name, fullPath);
            manifests.push(manifest);
          } catch (err) {
            log.warn(`Failed to parse plugin manifest: ${manifestPath}`);
          }
        }
      } catch (err) {
        log.debug(`Skipping path ${basePath}: ${(err as Error).message}`);
      }
    }

    log.info(`Discovered ${manifests.length} plugins`);
    return manifests;
  }

  /**
   * Load a single plugin from its manifest.
   */
  async loadPlugin(manifest: PluginManifest, sourcePath: string): Promise<LoadedPlugin> {
    validateManifest(manifest);
    if (this.disabled.has(manifest.name)) {
      throw new Error(`Plugin '${manifest.name}' is disabled`);
    }
    const existing = this.loadedPlugins.find((plugin) => plugin.manifest.name === manifest.name);
    if (existing) return existing;

    const skills = this.loadSkills(manifest, sourcePath);
    const tools = await this.loadTools(manifest, sourcePath);

    // Load commands
    const commands: PluginCommandDef[] = (manifest.commands ?? []).map((cmd) => ({
      ...cmd,
      name: cmd.name.startsWith('/') ? cmd.name : `/${cmd.name}`,
    }));

    const loaded: LoadedPlugin = {
      manifest,
      sourcePath,
      tools,
      skills,
      hooks: manifest.hooks ?? [],
      commands,
      mcpConfigs: manifest.mcpServers ?? [],
    };

    this.loadedPlugins.push(loaded);
    log.info(
      `Loaded plugin: ${manifest.name} v${manifest.version} (${tools.length} tools, ${skills.length} skills, ${commands.length} commands)`,
    );

    return loaded;
  }

  /**
   * Load all plugins.
   */
  async loadAll(): Promise<LoadedPlugin[]> {
    const manifests = await this.discoverPlugins();

    // Build path map
    const searchPaths = [...this.customPaths, ...PLUGIN_SEARCH_PATHS];
    for (const manifest of manifests) {
      if (this.disabled.has(manifest.name)) continue;
      const sourcePath = this.discoveredSources.get(manifest.name);
      if (!sourcePath) continue;
      try {
        await this.loadPlugin(manifest, sourcePath);
      } catch (error) {
        log.warn(
          `Failed to load plugin '${manifest.name}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return this.loadedPlugins;
  }

  // -------------------------------------------------------------------
  // Standard skills (Claude Code / Codex compatible SKILL.md)
  // -------------------------------------------------------------------

  /**
   * Load skills from standard Claude Code / Codex skill directories:
   * `<base>/<skill-name>/SKILL.md` with `name` / `description` frontmatter.
   * Custom paths are searched before the standard `~/.claude/skills`,
   * `~/.codex/skills`, `<cwd>/.claude/skills` and `<cwd>/.codex/skills`.
   */
  async loadStandaloneSkills(
    customPaths: string[] = [],
    options: { includeStandardPaths?: boolean } = {},
  ): Promise<Skill[]> {
    this.standaloneSkills = [];
    const searchPaths =
      options.includeStandardPaths === false
        ? [...customPaths]
        : [...new Set([...customPaths, ...STANDARD_SKILL_SEARCH_PATHS])];

    for (const basePath of searchPaths) {
      if (!existsSync(basePath)) continue;
      try {
        const entries = readdirSync(basePath);
        for (const entry of entries) {
          if (entry.startsWith('.')) continue; // skip hidden dirs (e.g. Codex .system)
          const skillDir = join(basePath, entry);
          if (!statSync(skillDir).isDirectory()) continue;
          const skillPath = join(skillDir, 'SKILL.md');
          if (!existsSync(skillPath)) continue;
          try {
            const parsed = parseSkillFile(readFileSync(skillPath, 'utf-8'));
            const name = parsed.name ?? entry;
            const description = parsed.description ?? parsed.name ?? entry;
            if (this.standaloneSkills.some((s) => s.name === name)) {
              log.warn(`Skipping duplicate skill '${name}' at ${skillPath}`);
              continue;
            }
            if (!parsed.name || !parsed.description) {
              log.warn(
                `Skill '${name}' at ${skillPath} is missing name/description frontmatter; ` +
                  `falling back to directory name`,
              );
            }
            this.standaloneSkills.push({
              name,
              description,
              content: parsed.content,
              triggers: parsed.triggers,
              sourcePath: skillPath,
            });
          } catch (err) {
            log.warn(`Failed to load skill from ${skillPath}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        log.debug(`Skipping path ${basePath}: ${(err as Error).message}`);
      }
    }

    log.info(`Loaded ${this.standaloneSkills.length} standard skills (Claude Code / Codex format)`);
    return this.standaloneSkills;
  }

  /**
   * Get all standalone skills loaded from standard skill directories.
   */
  getStandaloneSkills(): Skill[] {
    return [...this.standaloneSkills];
  }

  /**
   * Register every tool exported by loaded plugins.
   */
  registerTools(registry: ToolRegistry): Tool[] {
    const registered: Tool[] = [];
    for (const plugin of this.loadedPlugins) {
      for (const tool of plugin.tools) {
        try {
          registry.register(tool);
          registered.push(tool);
        } catch (error) {
          log.warn(
            `Could not register tool '${tool.name}' from '${plugin.manifest.name}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return registered;
  }

  private async loadTools(manifest: PluginManifest, sourcePath: string): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const definition of manifest.tools ?? []) {
      const entryPath = resolvePluginFile(sourcePath, definition.entry);
      if (!existsSync(entryPath)) {
        throw new Error(`Tool entry not found for '${definition.name}': ${entryPath}`);
      }
      const module = await importModule(entryPath);
      const exported = module.default ?? module.tool ?? module.createTool;
      const candidate =
        typeof exported === 'function'
          ? await exported({ manifest, pluginPath: sourcePath, definition })
          : exported;
      tools.push(normalizeTool(candidate, definition));
    }
    return tools;
  }

  // -------------------------------------------------------------------
  // Skill loading
  // -------------------------------------------------------------------

  /**
   * Load skills from a plugin manifest.
   */
  private loadSkills(manifest: PluginManifest, sourcePath: string): Skill[] {
    const skills: Skill[] = [];

    for (const skillDef of manifest.skills ?? []) {
      try {
        const skillPath = join(sourcePath, skillDef.file);
        if (!existsSync(skillPath)) {
          log.warn(`Skill file not found: ${skillPath}`);
          continue;
        }

        const content = readFileSync(skillPath, 'utf-8');
        // Standard frontmatter (name/description) or legacy triggers-only frontmatter
        const parsed = parseSkillFile(content);

        skills.push({
          name: skillDef.name,
          description: skillDef.description,
          content: parsed.content,
          triggers: skillDef.triggers ?? parsed.triggers,
          sourcePath: skillPath,
        });
      } catch (err) {
        log.warn(`Failed to load skill '${skillDef.name}': ${(err as Error).message}`);
      }
    }

    return skills;
  }

  /**
   * Search all loaded skills for ones matching a user query.
   */
  findSkills(query: string): Skill[] {
    const skills: Skill[] = [];
    const q = query.toLowerCase();

    const matches = (skill: Skill): boolean => {
      // Check triggers
      if (skill.triggers) {
        const matched = skill.triggers.some((t) => q.includes(t.toLowerCase()));
        if (matched) return true;
      }
      // Check name/description
      return skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q);
    };

    for (const skill of this.standaloneSkills) {
      if (matches(skill)) skills.push(skill);
    }
    for (const plugin of this.loadedPlugins) {
      for (const skill of plugin.skills) {
        if (matches(skill)) skills.push(skill);
      }
    }

    return skills;
  }

  /**
   * Get a skill by name.
   */
  getSkill(name: string): Skill | undefined {
    const standalone = this.standaloneSkills.find((s) => s.name === name);
    if (standalone) return standalone;
    for (const plugin of this.loadedPlugins) {
      const skill = plugin.skills.find((s) => s.name === name);
      if (skill) return skill;
    }
    return undefined;
  }

  /**
   * Get all loaded skills across all plugins.
   */
  getAllSkills(): Skill[] {
    return [...this.standaloneSkills, ...this.loadedPlugins.flatMap((p) => p.skills)];
  }

  // -------------------------------------------------------------------
  // Hook system
  // -------------------------------------------------------------------

  /**
   * Dispatch a hook event to all loaded plugins.
   * Returns results from all hook handlers.
   */
  async dispatchHook(
    event: HookEvent,
    context: Record<string, unknown>,
  ): Promise<{ pluginName: string; result: unknown }[]> {
    const results: { pluginName: string; result: unknown }[] = [];

    for (const plugin of this.loadedPlugins) {
      const matchingHooks = plugin.hooks.filter((h) => h.event === event);
      for (const hook of matchingHooks) {
        try {
          const key = `${plugin.manifest.name}:${event}:${hook.entry}`;
          let handler = this.hookHandlers.get(key);
          if (!handler) {
            const entryPath = resolvePluginFile(plugin.sourcePath, hook.entry);
            const module = await importModule(entryPath);
            const exported = module.default ?? module.handler ?? module[event];
            if (typeof exported !== 'function') {
              throw new Error(`Hook module '${hook.entry}' does not export a handler function`);
            }
            handler = exported as PluginHookHandler;
            this.hookHandlers.set(key, handler);
          }
          log.debug(`Hook ${event} triggered for plugin ${plugin.manifest.name}`);
          results.push({
            pluginName: plugin.manifest.name,
            result: await handler(context),
          });
        } catch (err) {
          log.warn(
            `Hook ${event} failed in plugin ${plugin.manifest.name}: ${(err as Error).message}`,
          );
        }
      }
    }

    return results;
  }

  // -------------------------------------------------------------------
  // Plugin management
  // -------------------------------------------------------------------

  getLoadedPlugins(): LoadedPlugin[] {
    return [...this.loadedPlugins];
  }

  isEnabled(name: string): boolean {
    return !this.disabled.has(name);
  }

  async disablePlugin(name: string, registry?: ToolRegistry): Promise<boolean> {
    this.disabled.add(name);
    const loaded = this.loadedPlugins.find((plugin) => plugin.manifest.name === name);
    if (!loaded) return false;
    for (const tool of loaded.tools) registry?.unregister(tool.name);
    this.loadedPlugins = this.loadedPlugins.filter((plugin) => plugin !== loaded);
    for (const key of [...this.hookHandlers.keys()]) {
      if (key.startsWith(`${name}:`)) this.hookHandlers.delete(key);
    }
    return true;
  }

  async enablePlugin(name: string): Promise<LoadedPlugin | null> {
    this.disabled.delete(name);
    const existing = this.loadedPlugins.find((plugin) => plugin.manifest.name === name);
    if (existing) return existing;
    await this.discoverPlugins();
    const sourcePath = this.discoveredSources.get(name);
    if (!sourcePath) return null;
    const manifest = JSON.parse(
      await readFile(join(sourcePath, 'plugin.json'), 'utf-8'),
    ) as PluginManifest;
    return this.loadPlugin(manifest, sourcePath);
  }

  async installPlugin(
    sourceDirectory: string,
    options: { targetDirectory?: string; overwrite?: boolean } = {},
  ): Promise<PluginManifest> {
    const source = resolve(sourceDirectory);
    const manifestPath = join(source, 'plugin.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`plugin.json not found in ${source}`);
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as PluginManifest;
    validateManifest(manifest);
    const root = resolve(options.targetDirectory ?? PLUGIN_SEARCH_PATHS[0]);
    const target = resolve(root, manifest.name);
    assertInside(target, root);
    await mkdir(root, { recursive: true });
    if (existsSync(target)) {
      if (!options.overwrite) {
        throw new Error(`Plugin '${manifest.name}' is already installed`);
      }
      await rm(target, { recursive: true, force: true });
    }
    await cp(source, target, { recursive: true, errorOnExist: true });
    this.discoveredSources.set(manifest.name, target);
    return manifest;
  }

  async uninstallPlugin(
    name: string,
    options: { targetDirectory?: string; registry?: ToolRegistry } = {},
  ): Promise<boolean> {
    await this.disablePlugin(name, options.registry);
    const root = resolve(options.targetDirectory ?? PLUGIN_SEARCH_PATHS[0]);
    const target = resolve(root, name);
    assertInside(target, root);
    if (!existsSync(target)) return false;
    await rm(target, { recursive: true, force: true });
    this.discoveredSources.delete(name);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedSkillFile {
  name?: string;
  description?: string;
  triggers?: string[];
  content: string;
}

/**
 * 解析输入中的显式技能引用（`/skill-name`，兼容 `#skill-name`）。
 * 返回命中的技能列表与移除引用标记后的输入；未命中已加载技能的标记原样保留
 * （避免破坏普通文本中的路径，如 /tmp/foo、issue #123）。
 */
export function parseSkillReferences(
  input: string,
  getSkill: (name: string) => Skill | undefined,
): { skills: Skill[]; cleaned: string } {
  const skills: Skill[] = [];
  const cleaned = input.replace(
    /([#/])([a-zA-Z0-9][a-zA-Z0-9._-]*)/g,
    (match, _marker: string, name: string) => {
      const skill = getSkill(name);
      if (!skill) return match; // 未命中已加载技能：保留原文（路径、issue 编号等不受影响）
      if (!skills.some((s) => s.name === skill.name)) skills.push(skill);
      return '';
    },
  );
  return { skills, cleaned: cleaned.replace(/\s+/g, ' ').trim() };
}

type PluginHookHandler = (context: Record<string, unknown>) => unknown | Promise<unknown>;

function validateManifest(manifest: PluginManifest): void {
  if (!manifest.name?.trim()) throw new Error('Plugin manifest requires a name');
  if (!manifest.version?.trim()) throw new Error(`Plugin '${manifest.name}' requires a version`);
  if (!manifest.description?.trim()) {
    throw new Error(`Plugin '${manifest.name}' requires a description`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.name)) {
    throw new Error(`Invalid plugin name: '${manifest.name}'`);
  }
}

function resolvePluginFile(sourcePath: string, entry: string): string {
  if (!entry || isAbsolute(entry)) {
    throw new Error(`Plugin entry must be a relative path: '${entry}'`);
  }
  const root = resolve(sourcePath);
  const target = resolve(root, entry);
  assertInside(target, root);
  return target;
}

function assertInside(target: string, root: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '' || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error(`Plugin path escapes its root: ${target}`);
  }
}

async function importModule(entryPath: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(entryPath);
  url.searchParams.set('loaded', String(statSync(entryPath).mtimeMs));
  return import(url.href) as Promise<Record<string, unknown>>;
}

function normalizeTool(candidate: unknown, definition: PluginToolDef): Tool {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`Tool '${definition.name}' did not export a tool object`);
  }
  const value = candidate as Partial<Tool>;
  if (typeof value.execute !== 'function') {
    throw new Error(`Tool '${definition.name}' does not implement execute()`);
  }

  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    category: definition.category ?? value.category ?? 'utility',
    requiresPermission: definition.requiresPermission ?? value.requiresPermission ?? false,
    isDangerous: definition.isDangerous ?? value.isDangerous ?? false,
    canBeUsedInSubAgent: definition.canBeUsedInSubAgent ?? value.canBeUsedInSubAgent ?? false,
    validateParams:
      typeof value.validateParams === 'function'
        ? value.validateParams.bind(candidate)
        : (params) => validateToolParams(definition.inputSchema, params),
    execute: value.execute.bind(candidate),
  };
}

function validateToolParams(
  schema: JSONSchema,
  params: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const errors = (schema.required ?? [])
    .filter((name) => params[name] === undefined || params[name] === null)
    .map((name) => `Missing required parameter: ${name}`);
  return { valid: errors.length === 0, errors };
}

/**
 * Parse a skill markdown file. Supports the standard Claude Code / Codex
 * frontmatter (`name`, `description`, delimiters on their own lines) plus an
 * optional `triggers` extension used by this project for auto-triggering.
 */
function parseSkillFile(raw: string): ParsedSkillFile {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('---')) {
    return { content: trimmed };
  }

  const lines = trimmed.split(/\r?\n/);
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { content: trimmed };
  }

  const yamlBlock = lines.slice(1, endIdx).join('\n');
  const content = lines.slice(endIdx + 1).join('\n').trim();

  try {
    const parsed = parseYaml(yamlBlock) as Record<string, unknown>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      triggers: Array.isArray(parsed.triggers)
        ? parsed.triggers.filter((t): t is string => typeof t === 'string')
        : undefined,
      content,
    };
  } catch {
    // If YAML parse fails, return everything as content
    return { content: trimmed };
  }
}
