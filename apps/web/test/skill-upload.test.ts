import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import AdmZip from 'adm-zip';
import { installSkillFromZip, SkillUploadError } from '../src/skill-upload';

function buildZip(files: Record<string, string | null>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    if (content === null) {
      zip.addFile(name, Buffer.alloc(0)); // 目录条目（以 / 结尾）
    } else {
      zip.addFile(name, Buffer.from(content, 'utf-8'));
    }
  }
  return zip.toBuffer();
}

/**
 * 手工构造 ZIP（store 方式），保留原始 entryName——用于模拟外部工具
 * （7-Zip、Python zipfile 等）生成的恶意压缩包，因为 adm-zip 创建时会净化 `../`。
 */
function buildRawZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // store
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}

test('installs a standard skill directory from zip using the zip file name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-skill-install-'));
  try {
    // zip 内部根目录名与 zip 文件名可以不一致，安装后目录名 = zip 文件名
    const zip = buildZip({
      'inner-dir/SKILL.md': '---\nname: my-skill\ndescription: A demo skill\n---\n\n# Demo\n\nDo the thing.',
      'inner-dir/scripts/run.sh': '#!/bin/sh\necho hi',
      'inner-dir/scripts/': null,
      'inner-dir/assets/': null,
    });
    const result = await installSkillFromZip(zip, root, 'my-zip-file');
    assert.equal(result.name, 'my-zip-file');
    assert.equal(result.fileCount, 2);
    assert.equal(result.path, join(root, 'my-zip-file'));

    const skillMd = await readFile(join(root, 'my-zip-file', 'SKILL.md'), 'utf-8');
    assert.match(skillMd, /name: my-skill/);
    const script = await readFile(join(root, 'my-zip-file', 'scripts', 'run.sh'), 'utf-8');
    assert.equal(script, '#!/bin/sh\necho hi');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses fallback name when SKILL.md sits at the zip root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-skill-install-'));
  try {
    const zip = buildZip({ 'SKILL.md': '# Root skill' });
    const result = await installSkillFromZip(zip, root, 'root-skill');
    assert.equal(result.name, 'root-skill');
    assert.equal(result.path, join(root, 'root-skill'));
    const skillMd = await readFile(join(root, 'root-skill', 'SKILL.md'), 'utf-8');
    assert.equal(skillMd, '# Root skill');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects zip with no SKILL.md', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-skill-install-'));
  try {
    const zip = buildZip({ 'notes/readme.md': 'nothing here' });
    await assert.rejects(
      () => installSkillFromZip(zip, root),
      (err: unknown) =>
        err instanceof SkillUploadError &&
        err.code === 'no_skill_md' &&
        err.message.includes('SKILL.md'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects zip containing multiple skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-skill-install-'));
  try {
    const zip = buildZip({ 'a/SKILL.md': '# A', 'b/SKILL.md': '# B' });
    await assert.rejects(
      () => installSkillFromZip(zip, root),
      (err: unknown) => err instanceof SkillUploadError && err.code === 'multiple_skills',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects zip-slip paths from externally crafted zips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-skill-install-'));
  try {
    const zip = buildRawZip([{ name: '../evil/SKILL.md', data: Buffer.from('# Evil', 'utf-8') }]);
    await assert.rejects(
      () => installSkillFromZip(zip, root),
      (err: unknown) => err instanceof SkillUploadError && err.code === 'zip_slip',
    );
    const escaped = join(root, 'evil');
    await assert.rejects(() => readFile(join(escaped, 'SKILL.md')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects corrupt zip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-skill-install-'));
  try {
    await assert.rejects(
      () => installSkillFromZip(Buffer.from('this is not a zip file'), root),
      (err: unknown) => err instanceof SkillUploadError && err.code === 'invalid_zip',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects when the skill already exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-agent-skill-install-'));
  try {
    const zip = buildZip({ 'dup-skill/SKILL.md': '# Dup' });
    await installSkillFromZip(zip, root);
    await assert.rejects(
      () => installSkillFromZip(zip, root),
      (err: unknown) => err instanceof SkillUploadError && err.code === 'exists',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
