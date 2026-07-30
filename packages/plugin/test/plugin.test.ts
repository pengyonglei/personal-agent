import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ToolRegistry } from '@personal-agent/tool';
import { PluginLoader } from '../src/index';

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
