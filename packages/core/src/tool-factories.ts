import { BaseTool, type Tool, type ToolContext, type ToolResult } from '@personal-agent/tool';
import { PlanModeEngine, type Plan, type CreatePlanInput } from './plan-mode';

// ---------------------------------------------------------------------------
// Shared plan/memory tool factories
//
// CLI 与 Web 各自的 submit_plan / get_plan / update_plan_step /
// read_memory / write_memory 实现此前为双份拷贝，描述文本已漂移。
// 此处收敛为共享工厂：两端只注入宿主差异（计划模式状态、会话路由、
// publishPlan 推送），描述与执行逻辑单一来源。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plan tools
// ---------------------------------------------------------------------------

/**
 * 宿主适配接口：CLI / Web 各自注入 plan 模式状态与会话路由。
 * 全部方法为结构类型（duck typing），不绑定具体宿主实现。
 */
export interface PlanToolHost {
  /** 当前 context 是否处于计划模式（submit_plan 仅在计划模式可用） */
  isPlanModeActive(context: ToolContext): boolean;
  /** 获取当前 context 对应的 PlanModeEngine；不可用返回 null */
  getPlanEngine(context: ToolContext): PlanModeEngine | null;
  /** 计划变更后的推送回调（CLI 无 UI 推送可省略；Web 用于推送前端计划卡片） */
  publishPlan?(context: ToolContext): void;
}

/** submit_plan 的统一描述（含 step id 与依赖说明，两端合并版） */
const SUBMIT_PLAN_DESCRIPTION =
  'Submit a structured implementation plan for user approval, including dependencies and risks. Use stable step ids such as step-1 and reference those ids from dependencies.';

/** get_plan 的统一描述 */
const GET_PLAN_DESCRIPTION = 'Get the current structured plan and its execution progress.';

/** update_plan_step 的统一描述 */
const UPDATE_PLAN_STEP_DESCRIPTION =
  'Update a step in the approved plan as execution progresses.';

/** 创建 plan 三件套工具（submit_plan / get_plan / update_plan_step）。 */
export function createPlanTools(host: PlanToolHost): Tool[] {
  const submitPlanTool = new (class extends BaseTool {
    readonly name = 'submit_plan';
    readonly description = SUBMIT_PLAN_DESCRIPTION;
    readonly category = 'plan' as const;
    readonly inputSchema = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short plan title' },
        description: { type: 'string', description: 'Plan overview' },
        risks: { type: 'array', items: { type: 'string' } },
        estimated_tokens: { type: 'number' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              tool_calls: { type: 'array', items: { type: 'string' } },
              dependencies: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'description'],
          },
        },
      },
      required: ['title', 'steps'],
    };

    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const engine = host.getPlanEngine(context);
      if (!host.isPlanModeActive(context) || !engine) {
        return {
          success: false,
          content: '',
          error: 'submit_plan is only available in plan mode',
        };
      }
      const rawSteps = Array.isArray(params.steps) ? params.steps : [];
      const plan = engine.createPlan({
        title: String(params.title ?? ''),
        description: String(params.description ?? ''),
        risks: Array.isArray(params.risks) ? params.risks.map(String) : [],
        estimatedTokens: Number(params.estimated_tokens ?? 0),
        steps: rawSteps.map((raw, index) => {
          const step = raw as Record<string, unknown>;
          return {
            id: String(step.id ?? `step-${index + 1}`),
            title: String(step.title ?? ''),
            description: String(step.description ?? ''),
            toolCalls: Array.isArray(step.tool_calls) ? step.tool_calls.map(String) : [],
            dependencies: Array.isArray(step.dependencies) ? step.dependencies.map(String) : [],
          };
        }),
      });
      host.publishPlan?.(context);
      return { success: true, content: formatPlan(plan) };
    }
  })();

  const getPlanTool = new (class extends BaseTool {
    readonly name = 'get_plan';
    readonly description = GET_PLAN_DESCRIPTION;
    readonly category = 'plan' as const;
    readonly inputSchema = { type: 'object', properties: {} };

    async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const plan = host.getPlanEngine(context)?.getPlan() ?? null;
      return { success: true, content: plan ? formatPlan(plan) : 'No active plan.' };
    }
  })();

  const updatePlanStepTool = new (class extends BaseTool {
    readonly name = 'update_plan_step';
    readonly description = UPDATE_PLAN_STEP_DESCRIPTION;
    readonly category = 'plan' as const;
    readonly inputSchema = {
      type: 'object',
      properties: {
        step_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['in_progress', 'completed', 'failed', 'skipped'],
        },
        output: { type: 'string' },
      },
      required: ['step_id', 'status'],
    };

    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const engine = host.getPlanEngine(context);
      if (!engine) {
        return { success: false, content: '', error: 'Conversation not found' };
      }
      const stepId = String(params.step_id);
      const status = String(params.status);
      const output = params.output === undefined ? undefined : String(params.output);
      const step =
        status === 'in_progress'
          ? await engine.startStep(stepId)
          : status === 'completed'
            ? await engine.completeStep(stepId, output)
            : status === 'failed'
              ? await engine.failStep(stepId, output)
              : status === 'skipped'
                ? await engine.skipStep(stepId)
                : null;
      host.publishPlan?.(context);
      return step
        ? {
            success: true,
            content: `Step ${step.id} is ${step.status}. Progress: ${engine.getProgress().percentage}%`,
          }
        : { success: false, content: '', error: `Unknown step/status: ${stepId}/${status}` };
    }
  })();

  return [submitPlanTool, getPlanTool, updatePlanStepTool];
}

// ---------------------------------------------------------------------------
// Memory tools
// ---------------------------------------------------------------------------

/**
 * 最小结构类型：宿主的 memory store（不引入 @personal-agent/memory 依赖）。
 * 注意：必须使用方法语法（method shorthand）而非属性函数，方法参数为双变
 * （bivariant），可直接接受 FileSystemMemoryStore 的 create/search 实现。
 */
export interface MemoryStoreLike {
  search(
    query: string,
    options: { maxResults: number },
  ): Promise<Array<{ entry: { type: string; content: string } }>>;
  create(data: {
    type: 'fact' | 'preference' | 'session_summary' | 'project_context' | 'decision';
    content: string;
    tags: string[];
    metadata?: { importance?: 1 | 2 | 3; sourceSessionId?: string };
  }): Promise<{ id: string }>;
}

/** 宿主适配接口：提供 store 与会话 id（写入 sourceSessionId 用）。 */
export interface MemoryToolHost {
  /** 获取当前 context 对应的 memory store；不可用返回 null（宿主不注册即可） */
  getStore(context: ToolContext): MemoryStoreLike | null;
  /** 当前 context 的会话 id */
  getSessionId(context: ToolContext): string;
}

/** read_memory 的统一描述 */
const READ_MEMORY_DESCRIPTION = 'Search persistent memory for relevant facts and preferences.';

/** write_memory 的统一描述 */
const WRITE_MEMORY_DESCRIPTION =
  'Persist a fact, preference, or decision for later conversations.';

/** 创建 memory 两件套工具（read_memory / write_memory）。 */
export function createMemoryTools(host: MemoryToolHost): Tool[] {
  const readMemoryTool = new (class extends BaseTool {
    readonly name = 'read_memory';
    readonly description = READ_MEMORY_DESCRIPTION;
    readonly category = 'memory' as const;
    readonly inputSchema = {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    };

    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const store = host.getStore(context);
      if (!store) {
        return { success: false, content: '', error: 'Memory store is not available' };
      }
      const results = await store.search(String(params.query), { maxResults: 5 });
      const text = results
        .map(({ entry }) => `[${entry.type}] ${entry.content}`)
        .join('\n');
      return { success: true, content: text || '(no relevant memories found)' };
    }
  })();

  const writeMemoryTool = new (class extends BaseTool {
    readonly name = 'write_memory';
    readonly description = WRITE_MEMORY_DESCRIPTION;
    readonly category = 'memory' as const;
    readonly requiresPermission = true;
    readonly inputSchema = {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to remember' },
        type: {
          type: 'string',
          enum: ['fact', 'preference', 'decision'],
          description: 'Memory type',
        },
        importance: { type: 'number', description: '1=critical, 2=important, 3=info' },
      },
      required: ['content'],
    };

    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const store = host.getStore(context);
      if (!store) {
        return { success: false, content: '', error: 'Memory store is not available' };
      }
      const importance = Number(params.importance ?? 2);
      if (![1, 2, 3].includes(importance)) {
        return { success: false, content: '', error: 'importance must be 1, 2, or 3' };
      }
      const entry = await store.create({
        type: (params.type as 'fact' | 'preference' | 'decision') ?? 'fact',
        content: String(params.content),
        tags: [],
        metadata: {
          importance: importance as 1 | 2 | 3,
          sourceSessionId: host.getSessionId(context),
        },
      });
      return { success: true, content: `Memory saved: ${entry.id}` };
    }
  })();

  return [readMemoryTool, writeMemoryTool];
}

// ---------------------------------------------------------------------------
// Shared plan formatter
// ---------------------------------------------------------------------------

/**
 * 将结构化计划格式化为文本（进度百分比 / 步骤标记 / 依赖 / 风险）。
 * 采用信息更全的 CLI 版，CLI 与 Web 共用，避免双份实现漂移。
 *
 * detail 两级：
 * - 'summary'（默认）：只输出步骤标题/依赖/状态标记，供 get_plan 等工具结果使用，保持紧凑；
 * - 'full'：额外输出每步的 description、tool_calls 与非空 output，供计划执行注入使用，
 *   保证模型执行时能看到规划阶段的完整细节，避免按标题脑补导致执行失真。
 */
export function formatPlan(plan: Plan, options?: { detail?: 'summary' | 'full' }): string {
  const detail = options?.detail ?? 'summary';
  const progressCounts = {
    completed: plan.steps.filter((step) => step.status === 'completed').length,
    settled: plan.steps.filter((step) =>
      ['completed', 'failed', 'skipped'].includes(step.status),
    ).length,
  };
  const percentage =
    plan.steps.length === 0 ? 100 : Math.round((progressCounts.settled / plan.steps.length) * 100);
  const lines = [
    `${plan.title} [${plan.status}]`,
    plan.description,
    `Progress: ${progressCounts.completed}/${plan.steps.length} completed (${percentage}% settled)`,
  ].filter(Boolean);
  for (const step of plan.steps) {
    const marker =
      step.status === 'completed'
        ? 'x'
        : step.status === 'in_progress'
          ? '>'
          : step.status === 'failed'
            ? '!'
            : step.status === 'skipped'
              ? '-'
              : ' ';
    const dependencies =
      step.dependencies.length > 0 ? ` (after: ${step.dependencies.join(', ')})` : '';
    lines.push(`[${marker}] ${step.id}: ${step.title}${dependencies}`);
    if (detail === 'full') {
      if (step.description.trim()) {
        lines.push(`    ${step.description.trim().replace(/\n/g, '\n    ')}`);
      }
      if (step.toolCalls.length > 0) {
        lines.push(`    Tools: ${step.toolCalls.join(', ')}`);
      }
      if (step.output !== undefined && step.output.trim() !== '') {
        lines.push(`    Output: ${step.output.trim().replace(/\n/g, '\n    ')}`);
      }
    }
  }
  if (plan.metadata.risks.length > 0) {
    lines.push(`Risks: ${plan.metadata.risks.join('; ')}`);
  }
  return lines.join('\n');
}

// 保留类型导出：CreatePlanInput 由 submit_plan 的 host 侧使用（便于宿主实现）
export type { CreatePlanInput };
