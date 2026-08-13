import type { Plan } from '@personal-agent/core';

/** 计划文档：由结构化 Plan 生成的 Markdown 文档（服务端落盘到 ~/.personal-agent/plans）。 */
export interface PlanDoc {
  id: string;
  /** 产生该计划的会话任务 id（历史恢复时用于按任务重放卡片）。 */
  taskId?: string;
  title: string;
  markdown: string;
  plan: Plan;
  createdAt: number;
  updatedAt: number;
  /** 计划创建所属轮次序号（该任务的第几次用户请求，1-based），客户端刷新后按此把卡片插到对应回复下方。 */
  requestSeq?: number;
}

const PLAN_STATUS_LABELS: Record<string, string> = {
  draft: '待批准',
  approved: '已批准',
  in_progress: '执行中',
  completed: '已完成',
};

const STEP_STATUS_LABELS: Record<string, string> = {
  pending: '待执行',
  in_progress: '执行中',
  completed: '已完成',
  skipped: '已跳过',
  failed: '失败',
};

/** 计划状态 → 中文标签（卡片 Tag 与文档头部共用）。 */
export function planStatusLabel(status: string): string {
  return PLAN_STATUS_LABELS[status] ?? status;
}

/** 步骤状态 → 中文标签（文档执行步骤小节标题共用）。 */
export function stepStatusLabel(status: string): string {
  return STEP_STATUS_LABELS[status] ?? status;
}

function formatDateTime(value: Date): string {
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(value);
  }
}

/**
 * 将结构化计划转换为中文 Markdown 文档。
 * 「执行步骤」每个步骤升格为小节：标题带状态标记，正文包含步骤描述，
 * 并数据驱动地渲染依赖、工具调用与产出（仅在有值时输出）；
 * 计划级标题/描述、风险、元信息小节保留。
 */
export function planToMarkdown(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title}`);
  if (plan.description.trim()) {
    lines.push('', plan.description.trim());
  }
  lines.push('', '## 执行步骤');
  for (const step of plan.steps) {
    lines.push('', `### ${step.order}. ${step.title} [${stepStatusLabel(step.status)}]`);
    if (step.description.trim()) {
      lines.push(step.description.trim());
    }
    if (step.dependencies.length > 0) {
      lines.push(`- 依赖：${step.dependencies.join('、')}`);
    }
    if (step.toolCalls.length > 0) {
      lines.push(`- 工具：${step.toolCalls.join('、')}`);
    }
    if (
      (step.status === 'completed' || step.status === 'failed') &&
      step.output !== undefined &&
      step.output.trim() !== ''
    ) {
      lines.push(`- 产出：${step.output.trim()}`);
    }
  }
  if (plan.metadata.risks.length > 0) {
    lines.push('', '## 风险', '');
    for (const risk of plan.metadata.risks) lines.push(`- ${risk}`);
  }
  lines.push('', '## 元信息', '');
  lines.push(`- 状态：${planStatusLabel(plan.status)}`);
  lines.push(`- 创建时间：${formatDateTime(plan.metadata.createdAt)}`);
  if (plan.metadata.estimatedTokens > 0) {
    lines.push(`- 预估 token：${plan.metadata.estimatedTokens.toLocaleString('en-US')}`);
  }
  return lines.join('\n');
}
