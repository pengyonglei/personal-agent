import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ToolRegistry } from '@personal-agent/tool';
import { parseSkillReferences, PluginLoader, type Skill } from '../src/index';

async function createFixture(root: string): Promise<string> {
  const source = join(root, 'source-plugin');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, 'plugin.json'),
    JSON.stringify({
      name: 'fixture-plugin',
      version: '1.0.0',
      description: 'Plugin fixture',
      tools: [
        {
          name: 'fixture_echo',
          description: 'Echo text',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
          entry: './tool.mjs',
        },
      ],
      skills: [
        {
          name: 'fixture-skill',
          description: 'A test skill',
          file: './skill.md',
          triggers: ['fixture'],
        },
      ],
      hooks: [{ event: 'on_user_input', entry: './hook.mjs' }],
    }),
    'utf-8',
  );
  await writeFile(
    join(source, 'tool.mjs'),
    'export default { async execute(params) { return { success: true, content: `echo:${params.text}` }; } };',
    'utf-8',
  );
  await writeFile(
    join(source, 'hook.mjs'),
    'export default async (context) => `hook:${context.input}`;',
    'utf-8',
  );
  await writeFile(join(source, 'skill.md'), '# Fixture skill\n\nAlways answer precisely.', 'utf-8');
  return source;
}

test('loads plugin tools, skills and executable hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-plugin-'));
  const source = await createFixture(root);
  const loader = new PluginLoader([root]);
  try {
    const plugins = await loader.loadAll();
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].sourcePath, source);
    assert.equal(loader.findSkills('use the fixture workflow').length, 1);

    const registry = new ToolRegistry();
    loader.registerTools(registry);
    const tool = registry.get('fixture_echo');
    assert.ok(tool);
    assert.deepEqual(tool.validateParams({}).errors, ['Missing required parameter: text']);
    const result = await tool.execute(
      { text: 'hello' },
      { sessionId: 'test', workingDirectory: root },
    );
    assert.equal(result.content, 'echo:hello');

    const hookResults = await loader.dispatchHook('on_user_input', { input: 'hello' });
    assert.deepEqual(hookResults, [{ pluginName: 'fixture-plugin', result: 'hook:hello' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('supports install, disable, enable and uninstall lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-plugin-lifecycle-'));
  const source = await createFixture(root);
  const installedRoot = join(root, 'installed');
  const loader = new PluginLoader([installedRoot]);
  try {
    const manifest = await loader.installPlugin(source, { targetDirectory: installedRoot });
    assert.equal(manifest.name, 'fixture-plugin');
    const loaded = await loader.enablePlugin('fixture-plugin');
    assert.equal(loaded?.manifest.name, 'fixture-plugin');

    const registry = new ToolRegistry();
    loader.registerTools(registry);
    assert.ok(registry.get('fixture_echo'));
    assert.equal(await loader.disablePlugin('fixture-plugin', registry), true);
    assert.equal(registry.get('fixture_echo'), undefined);
    assert.equal(loader.isEnabled('fixture-plugin'), false);

    assert.ok(await loader.enablePlugin('fixture-plugin'));
    assert.equal(
      await loader.uninstallPlugin('fixture-plugin', { targetDirectory: installedRoot }),
      true,
    );
    assert.equal(
      await loader.uninstallPlugin('fixture-plugin', { targetDirectory: installedRoot }),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loads standalone skills from standard SKILL.md directories (Claude Code / Codex format)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-skills-'));
  try {
    // Standard skill directory: <base>/<skill-name>/SKILL.md
    const skillDir = join(root, 'my-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: my-skill',
        'description: Use when reviewing Vue components or building forms',
        'triggers:',
        '  - 浠ｇ爜瀹℃煡',
        '  - code-review',
        '---',
        '',
        '# My Skill',
        '',
        'Always inspect package.json before writing code.',
      ].join('\n'),
      'utf-8',
    );

    // Hidden directories (e.g. Codex .system) must be skipped
    const hiddenDir = join(root, '.system');
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(join(hiddenDir, 'SKILL.md'), '---\nname: hidden\n---\nno', 'utf-8');

    const loader = new PluginLoader();
    const skills = await loader.loadStandaloneSkills([root], { includeStandardPaths: false });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'my-skill');
    assert.equal(skills[0].description, 'Use when reviewing Vue components or building forms');
    assert.deepEqual(skills[0].triggers, ['浠ｇ爜瀹℃煡', 'code-review']);
    assert.ok(skills[0].content.includes('Always inspect package.json before writing code.'));
    assert.equal(skills[0].sourcePath, join(skillDir, 'SKILL.md'));

    // Matching: by description, by name, and by triggers
    assert.equal(loader.findSkills('reviewing Vue components').length, 1);
    assert.equal(loader.findSkills('浠ｇ爜瀹℃煡').length, 1);
    assert.equal(loader.getSkill('my-skill')?.name, 'my-skill');
    assert.equal(loader.getAllSkills().length, 1);
    assert.equal(loader.getStandaloneSkills().length, 1);
    assert.equal(loader.findSkills('unrelated query').length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falls back to directory name when SKILL.md has no frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-skills-nometa-'));
  try {
    const skillDir = join(root, 'no-meta-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# No meta\n\nJust plain content.', 'utf-8');

    const loader = new PluginLoader();
    const skills = await loader.loadStandaloneSkills([root], { includeStandardPaths: false });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'no-meta-skill');
    assert.equal(skills[0].description, 'no-meta-skill');
    assert.ok(skills[0].content.includes('Just plain content.'));
    assert.equal(loader.findSkills('no-meta-skill').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parseSkillReferences extracts explicit skill references and cleans input', () => {
  const skills: Skill[] = [
    { name: 'code-review', description: 'Review code', content: '# Review', sourcePath: '/x/SKILL.md' },
    { name: 'ant-design-vue', description: 'Vue UI', content: '# Vue', sourcePath: '/y/SKILL.md' },
  ];
  const getSkill = (name: string) => skills.find((skill) => skill.name === name);

  // / 前缀：多个引用按出现顺序命中，标记从输入中移除
  const multi = parseSkillReferences('请用 /code-review 审查 /ant-design-vue 页面', getSkill);
  assert.equal(multi.skills.map((s) => s.name).join(','), 'code-review,ant-design-vue');
  assert.equal(multi.cleaned, '请用 审查 页面');

  // # 前缀仍然兼容
  const hash = parseSkillReferences('#code-review 帮我看看', getSkill);
  assert.equal(hash.skills.length, 1);
  assert.equal(hash.cleaned, '帮我看看');

  // 未命中已加载技能的标记保留原文（不误删路径/编号）
  const unknown = parseSkillReferences('/not-exist 你好', getSkill);
  assert.equal(unknown.skills.length, 0);
  assert.equal(unknown.cleaned, '/not-exist 你好');

  const path = parseSkillReferences('删除 /tmp/foo 目录并处理 issue #123', getSkill);
  assert.equal(path.skills.length, 0);
  assert.equal(path.cleaned, '删除 /tmp/foo 目录并处理 issue #123');

  // 重复引用去重
  const dup = parseSkillReferences('/code-review 然后 /code-review 再来一次', getSkill);
  assert.equal(dup.skills.length, 1);
  assert.equal(dup.cleaned, '然后 再来一次');

  // 无引用时输入原样返回
  const plain = parseSkillReferences('普通输入没有引用', getSkill);
  assert.equal(plain.skills.length, 0);
  assert.equal(plain.cleaned, '普通输入没有引用');
});
