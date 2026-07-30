import { createLogger, generateId } from '@personal-agent/shared';

const log = createLogger('plan-mode');

export interface Plan {
  id: string;
  title: string;
  description: string;
  status: 'draft' | 'approved' | 'in_progress' | 'completed';
  steps: PlanStep[];
  metadata: {
    createdAt: Date;
    approvedAt?: Date;
    completedAt?: Date;
    estimatedTokens: number;
    risks: string[];
  };
}

export interface PlanStep {
  id: string;
  order: number;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
  toolCalls: string[];
  dependencies: string[];
  output?: string;
}

export interface PlanProgress {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  current: number;
  percentage: number;
}

export interface CreatePlanInput {
  title: string;
  description?: string;
  estimatedTokens?: number;
  risks?: string[];
  steps: Array<{
    id?: string;
    title: string;
    description: string;
    toolCalls?: string[];
    dependencies?: string[];
  }>;
}

export class PlanModeEngine {
  private plan: Plan | null = null;
  private onStepUpdate?: (step: PlanStep) => void;

  setPlan(plan: Plan): void {
    this.validatePlan(plan);
    this.plan = clonePlan(plan);
    log.info(`Plan set: ${plan.id} - ${plan.steps.length} steps`);
  }

  createPlan(input: CreatePlanInput): Plan {
    const plan: Plan = {
      id: `plan-${generateId()}`,
      title: input.title,
      description: input.description ?? '',
      status: 'draft',
      steps: input.steps.map((step, index) => ({
        id: step.id?.trim() || `step-${index + 1}`,
        order: index + 1,
        title: step.title,
        description: step.description,
        status: 'pending',
        toolCalls: [...(step.toolCalls ?? [])],
        dependencies: [...(step.dependencies ?? [])],
      })),
      metadata: {
        createdAt: new Date(),
        estimatedTokens: input.estimatedTokens ?? 0,
        risks: [...(input.risks ?? [])],
      },
    };
    this.setPlan(plan);
    return clonePlan(plan);
  }

  clearPlan(): void {
    this.plan = null;
  }

  approvePlan(): Plan | null {
    if (!this.plan) return null;
    if (this.plan.status !== 'draft') return clonePlan(this.plan);
    this.plan.status = 'approved';
    this.plan.metadata.approvedAt = new Date();
    return clonePlan(this.plan);
  }

  async startStep(stepId: string): Promise<PlanStep | null> {
    const step = this.findStep(stepId);
    if (!step) return null;
    if (!this.plan || !['approved', 'in_progress'].includes(this.plan.status)) {
      throw new Error('Plan must be approved before a step can start');
    }

    const unmet = step.dependencies.filter((dependencyId) => {
      const dependency = this.findStep(dependencyId);
      return !dependency || !['completed', 'skipped'].includes(dependency.status);
    });
    if (unmet.length > 0) {
      throw new Error(`Step '${stepId}' has unmet dependencies: ${unmet.join(', ')}`);
    }

    step.status = 'in_progress';
    this.plan.status = 'in_progress';
    this.onStepUpdate?.({ ...step });
    return { ...step };
  }

  async completeStep(stepId: string, output?: string): Promise<PlanStep | null> {
    const step = this.findStep(stepId);
    if (!step) return null;
    if (step.status !== 'in_progress') {
      throw new Error(`Step '${stepId}' must be in progress before it can complete`);
    }
    step.status = 'completed';
    step.output = output;
    this.finishPlanIfComplete();
    this.onStepUpdate?.({ ...step });
    return { ...step };
  }

  async failStep(stepId: string, error?: string): Promise<PlanStep | null> {
    const step = this.findStep(stepId);
    if (!step) return null;
    if (step.status !== 'in_progress') {
      throw new Error(`Step '${stepId}' must be in progress before it can fail`);
    }
    step.status = 'failed';
    step.output = error;
    this.finishPlanIfComplete();
    this.onStepUpdate?.({ ...step });
    return { ...step };
  }

  async skipStep(stepId: string): Promise<PlanStep | null> {
    const step = this.findStep(stepId);
    if (!step) return null;
    if (!this.plan || !['approved', 'in_progress'].includes(this.plan.status)) {
      throw new Error('Plan must be approved before a step can be skipped');
    }
    if (step.status !== 'pending') {
      throw new Error(`Only a pending step can be skipped: '${stepId}'`);
    }
    step.status = 'skipped';
    this.finishPlanIfComplete();
    this.onStepUpdate?.({ ...step });
    return { ...step };
  }

  getProgress(): PlanProgress {
    if (!this.plan) {
      return { total: 0, completed: 0, failed: 0, skipped: 0, current: 0, percentage: 0 };
    }
    if (this.plan.steps.length === 0) {
      return { total: 0, completed: 0, failed: 0, skipped: 0, current: 0, percentage: 100 };
    }

    const completed = this.plan.steps.filter((step) => step.status === 'completed').length;
    const failed = this.plan.steps.filter((step) => step.status === 'failed').length;
    const skipped = this.plan.steps.filter((step) => step.status === 'skipped').length;
    const current = this.plan.steps.findIndex((step) => step.status === 'in_progress');
    return {
      total: this.plan.steps.length,
      completed,
      failed,
      skipped,
      current: current >= 0 ? current + 1 : 0,
      percentage: Math.round(((completed + failed + skipped) / this.plan.steps.length) * 100),
    };
  }

  getPlan(): Plan | null {
    return this.plan ? clonePlan(this.plan) : null;
  }

  isComplete(): boolean {
    if (!this.plan) return true;
    return this.plan.steps.every((step) =>
      ['completed', 'skipped', 'failed'].includes(step.status),
    );
  }

  getNextStep(): PlanStep | null {
    if (!this.plan || !['approved', 'in_progress'].includes(this.plan.status)) return null;

    for (const step of this.plan.steps) {
      if (step.status !== 'pending') continue;
      const dependenciesMet = step.dependencies.every((dependencyId) => {
        const dependency = this.findStep(dependencyId);
        return dependency && ['completed', 'skipped'].includes(dependency.status);
      });
      if (dependenciesMet) return { ...step };
    }
    return null;
  }

  onUpdate(callback: (step: PlanStep) => void): void {
    this.onStepUpdate = callback;
  }

  private findStep(stepId: string): PlanStep | null {
    return this.plan?.steps.find((step) => step.id === stepId) ?? null;
  }

  private finishPlanIfComplete(): void {
    if (!this.plan || !this.isComplete()) return;
    this.plan.status = 'completed';
    this.plan.metadata.completedAt = new Date();
  }

  private validatePlan(plan: Plan): void {
    if (!plan.title.trim()) throw new Error('Plan title is required');
    if (plan.steps.length === 0) throw new Error('Plan must contain at least one step');

    const ids = new Set<string>();
    for (const step of plan.steps) {
      if (!step.id.trim()) throw new Error('Every plan step must have an id');
      if (ids.has(step.id)) throw new Error(`Duplicate plan step id: ${step.id}`);
      ids.add(step.id);
    }
    for (const step of plan.steps) {
      for (const dependency of step.dependencies) {
        if (!ids.has(dependency)) {
          throw new Error(`Step '${step.id}' depends on unknown step '${dependency}'`);
        }
        if (dependency === step.id) {
          throw new Error(`Step '${step.id}' cannot depend on itself`);
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (stepId: string): void => {
      if (visiting.has(stepId)) {
        throw new Error(`Plan contains a dependency cycle at '${stepId}'`);
      }
      if (visited.has(stepId)) return;
      visiting.add(stepId);
      const step = plan.steps.find((candidate) => candidate.id === stepId)!;
      for (const dependency of step.dependencies) visit(dependency);
      visiting.delete(stepId);
      visited.add(stepId);
    };
    for (const step of plan.steps) visit(step.id);
  }
}

function clonePlan(plan: Plan): Plan {
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      toolCalls: [...step.toolCalls],
      dependencies: [...step.dependencies],
    })),
    metadata: {
      ...plan.metadata,
      createdAt: new Date(plan.metadata.createdAt),
      approvedAt: plan.metadata.approvedAt ? new Date(plan.metadata.approvedAt) : undefined,
      completedAt: plan.metadata.completedAt ? new Date(plan.metadata.completedAt) : undefined,
      risks: [...plan.metadata.risks],
    },
  };
}
