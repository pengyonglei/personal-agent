import test from 'node:test';
import assert from 'node:assert/strict';
import type { Plan } from '@personal-agent/core';
import { planStatusLabel, planToMarkdown } from '../client/src/plan-doc';

function createPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-test-1',
    title: '重构配置模块',
    description: '将配置加载逻辑拆分为独立模块并补充测试。',
    status: 'draft',
    steps: [
      {
        id: 'step-1',
        order: 1,
        title: '梳理现有配置加载路径',
        description: '分析 config.ts 的调用方与依赖。',
        status: 'pending',
        toolCalls: ['bash', 'read_file'],
        dependencies: [],
      },
      {
        id: 'step-2',
        order: 2,
        title: '抽取配置模块',
        description: '新建 config/ 目录并迁移代码。',
        status: 'pending',
        toolCalls: ['write_file', 'bash'],
        dependencies: ['step-1'],
      },
    ],
    metadata: {
      createdAt: new Date('2026-08-06T10:00:00Z'),
      estimatedTokens: 1200,
      risks: ['配置迁移可能导致环境差异', '需要回归验证'],
    },
    ...overrides,
  };
}

test('planToMarkdown renders plan title, description, step titles and risks', () => {
  const markdown = planToMarkdown(createPlan());
  assert.match(markdown, /^# 重构配置模块/m);
  assert.match(markdown, /将配置加载逻辑拆分为独立模块并补充测试/);
  assert.match(markdown, /## 执行步骤/);
  assert.match(markdown, /### 1\. 梳理现有配置加载路径 \[待执行\]/);
  assert.match(markdown, /### 2\. 抽取配置模块 \[待执行\]/);
  assert.match(markdown, /## 风险/);
  assert.match(markdown, /- 配置迁移可能导致环境差异/);
  assert.match(markdown, /- 需要回归验证/);
  assert.match(markdown, /## 元信息/);
  assert.match(markdown, /- 状态：待批准/);
  assert.match(markdown, /- 预估 token：1,200/);
});

test('planToMarkdown renders step descriptions, dependencies and tools', () => {
  const markdown = planToMarkdown(createPlan());
  assert.match(markdown, /分析 config\.ts 的调用方与依赖/);
  assert.match(markdown, /新建 config\/ 目录并迁移代码/);
  assert.match(markdown, /- 依赖：step-1/);
  assert.match(markdown, /- 工具：bash、read_file/);
  assert.match(markdown, /- 工具：write_file、bash/);
  // step-1 无依赖，不应出现空的依赖行
  assert.equal((markdown.match(/- 依赖：/g) ?? []).length, 1);
});

test('planToMarkdown renders step status markers and output for settled steps', () => {
  const markdown = planToMarkdown(
    createPlan({
      status: 'in_progress',
      steps: [
        {
          id: 'step-1',
          order: 1,
          title: '梳理现有配置加载路径',
          description: '分析 config.ts 的调用方与依赖。',
          status: 'completed',
          toolCalls: ['bash', 'read_file'],
          dependencies: [],
          output: '已完成梳理，确认 3 个调用方。',
        },
        {
          id: 'step-2',
          order: 2,
          title: '抽取配置模块',
          description: '新建 config/ 目录并迁移代码。',
          status: 'failed',
          toolCalls: ['write_file'],
          dependencies: ['step-1'],
          output: '迁移冲突，等待确认。',
        },
      ],
    }),
  );
  assert.match(markdown, /### 1\. 梳理现有配置加载路径 \[已完成\]/);
  assert.match(markdown, /- 产出：已完成梳理，确认 3 个调用方。/);
  assert.match(markdown, /### 2\. 抽取配置模块 \[失败\]/);
  assert.match(markdown, /- 产出：迁移冲突，等待确认。/);
  assert.match(markdown, /- 状态：执行中/);
});

test('planToMarkdown omits empty dependency/tool/output lines', () => {
  const markdown = planToMarkdown(
    createPlan({
      steps: [
        {
          id: 'step-1',
          order: 1,
          title: '单一空步骤',
          description: '',
          status: 'pending',
          toolCalls: [],
          dependencies: [],
        },
      ],
    }),
  );
  assert.match(markdown, /### 1\. 单一空步骤 \[待执行\]/);
  assert.doesNotMatch(markdown, /- 依赖：/);
  assert.doesNotMatch(markdown, /- 工具：/);
  assert.doesNotMatch(markdown, /- 产出：/);
});

test('planToMarkdown omits empty risks and zero estimated tokens', () => {
  const markdown = planToMarkdown(
    createPlan({
      metadata: {
        createdAt: new Date('2026-08-06T10:00:00Z'),
        estimatedTokens: 0,
        risks: [],
      },
    }),
  );
  assert.doesNotMatch(markdown, /## 风险/);
  assert.doesNotMatch(markdown, /预估 token/);
});

test('planToMarkdown reflects the plan status label', () => {
  const markdown = planToMarkdown(createPlan({ status: 'approved' }));
  assert.match(markdown, /- 状态：已批准/);
});

test('planStatusLabel maps every plan status and falls back to the raw value', () => {
  assert.equal(planStatusLabel('draft'), '待批准');
  assert.equal(planStatusLabel('approved'), '已批准');
  assert.equal(planStatusLabel('in_progress'), '执行中');
  assert.equal(planStatusLabel('completed'), '已完成');
  assert.equal(planStatusLabel('unknown'), 'unknown');
});
