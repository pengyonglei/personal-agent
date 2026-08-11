import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { createWebServer } from '../src/server';

async function startServer() {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-skills-web-'));
  const configPath = join(directory, 'config.yaml');
  await writeFile(
    configPath,
    [
      'memory:',
      '  enabled: false',
      'plugins:',
      '  enabled: false',
      'skills:',
      '  enabled: false',
      'mcp:',
      '  servers: []',
    ].join('\n'),
    'utf-8',
  );
  const clientBuildDirectory = join(directory, 'client');
  await mkdir(clientBuildDirectory);
  await writeFile(join(clientBuildDirectory, 'index.html'), '<h1>test client</h1>', 'utf8');
  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
    clientBuildDirectory,
    skillsDirectory: join(directory, 'skills'),
  });
  return { instance, directory };
}

test('GET /api/skills lists installed standard skills', async () => {
  const { instance, directory } = await startServer();
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/skills`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      directory: string;
      skills: Array<{ name: string; description: string; triggers: string[] }>;
    };
    assert.equal(payload.directory, join(directory, 'skills'));
    assert.ok(Array.isArray(payload.skills));
  } finally {
    await instance.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('POST /api/skills/upload installs a skill zip and reloads the runtime', async () => {
  const { instance, directory } = await startServer();
  try {
    const zip = new AdmZip();
    // zip 内部目录名与 zip 文件名不同，安装目录名应取 zip 文件名
    zip.addFile(
      'inner-folder/SKILL.md',
      Buffer.from(
        '---\nname: uploaded-skill\ndescription: Uploaded via zip\n---\n\n# Uploaded\n\nInstructions.',
        'utf-8',
      ),
    );
    const buffer = zip.toBuffer();

    const uploadResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/skills/upload?name=my-upload.zip`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: buffer,
      },
    );
    assert.equal(uploadResponse.status, 201);
    const uploaded = (await uploadResponse.json()) as {
      skill: { name: string; path: string; fileCount: number };
    };
    assert.equal(uploaded.skill.name, 'my-upload');
    assert.equal(uploaded.skill.fileCount, 1);
    assert.equal(uploaded.skill.path, join(directory, 'skills', 'my-upload'));

    // 落盘验证：SKILL.md 直接位于以 zip 文件名为名的目录下
    const skillMd = await readFile(join(directory, 'skills', 'my-upload', 'SKILL.md'), 'utf-8');
    assert.match(skillMd, /name: uploaded-skill/);

    // 列表应包含新技能（显示名来自 SKILL.md frontmatter 的 name）
    const listResponse = await fetch(`http://127.0.0.1:${instance.port}/api/skills`);
    const payload = (await listResponse.json()) as {
      skills: Array<{ name: string; description: string; sourcePath: string }>;
    };
    const names = payload.skills.map((skill) => skill.name);
    assert.ok(
      names.includes('uploaded-skill'),
      `expected uploaded-skill in ${names.join(', ')}`,
    );
    const installed = payload.skills.find((skill) => skill.name === 'uploaded-skill');
    assert.ok(installed?.sourcePath.includes('my-upload'), 'sourcePath should point at zip-file-named directory');
  } finally {
    await instance.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('POST /api/skills/upload rejects invalid zip and duplicate skills', async () => {
  const { instance, directory } = await startServer();
  try {
    // 无效 zip → 400
    const badResponse = await fetch(`http://127.0.0.1:${instance.port}/api/skills/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: Buffer.from('not a zip'),
    });
    assert.equal(badResponse.status, 400);
    const badPayload = (await badResponse.json()) as { error: string; code: string };
    assert.equal(badPayload.code, 'invalid_zip');

    // 正常上传（zip 文件名作为技能目录名）
    const zip = new AdmZip();
    zip.addFile('whatever/SKILL.md', Buffer.from('# Once', 'utf-8'));
    const okResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/skills/upload?name=once-skill.zip`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: zip.toBuffer(),
      },
    );
    assert.equal(okResponse.status, 201);

    // 重复上传同名 zip → 409
    const dupResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/skills/upload?name=once-skill.zip`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: zip.toBuffer(),
      },
    );
    assert.equal(dupResponse.status, 409);
    const dupPayload = (await dupResponse.json()) as { code: string };
    assert.equal(dupPayload.code, 'exists');
  } finally {
    await instance.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
