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
  assert.match(markdown, /1\. 梳理现有配置加载路径/);
  assert.match(markdown, /2\. 抽取配置模块/);
  assert.match(markdown, /## 风险/);
  assert.match(markdown, /- 配置迁移可能导致环境差异/);
  assert.match(markdown, /- 需要回归验证/);
  assert.match(markdown, /## 元信息/);
  assert.match(markdown, /- 状态：待批准/);
  assert.match(markdown, /- 预估 token：1,200/);
});

test('planToMarkdown step list contains only titles (no descriptions/dependencies/tools)', () => {
  const markdown = planToMarkdown(createPlan());
  assert.doesNotMatch(markdown, /分析 config\.ts 的调用方/);
  assert.doesNotMatch(markdown, /新建 config\/ 目录/);
  assert.doesNotMatch(markdown, /step-1/);
  assert.doesNotMatch(markdown, /write_file/);
  assert.doesNotMatch(markdown, /read_file/);
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
