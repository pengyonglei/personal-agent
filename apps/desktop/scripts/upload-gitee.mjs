/**
 * 上传桌面版产物到 Gitee Release（固定 tag: latest，自动更新通道）。
 *
 * 用法：
 *   GITEE_TOKEN=<私人令牌> node scripts/upload-gitee.mjs v0.2.8
 *   （或 pnpm desktop:publish:upload -- --version v0.2.8，release.mjs 已接线）
 *
 * 上传的产物（apps/desktop/out/ 下）：
 *   1. PersonalAgent-v<版本>-Setup.exe   （NSIS 安装包）
 *   2. PersonalAgent-v<版本>-Setup.exe.blockmap （差分更新块）
 *   3. latest.yml                         （electron-updater 更新元数据）
 *
 * 说明：electron-updater 会从
 *   https://gitee.com/{owner}/{repo}/releases/download/latest/latest.yml
 * 拉取元数据并下载对应安装包。每次发版请更新同一个 tag=latest 的 Release 附件
 * （旧附件可在 Gitee Release 页面手动删除，或忽略——同名附件以最新上传为准）。
 */
import { access, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GITEE_API = 'https://gitee.com/api/v5';
const OWNER = 'pengyonglei';
const REPO = 'personal-agent';
const TAG = 'latest';

const versionLabel = process.argv[2] ?? '';

async function requireFile(filePath) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`产物不存在：${filePath}\n请先运行 pnpm desktop:make -- --version ${versionLabel}`);
  }
}

async function findOrCreateRelease(token) {
  const listUrl = `${GITEE_API}/repos/${OWNER}/${REPO}/releases?access_token=${token}&per_page=100&page=1`;
  const response = await fetch(listUrl);
  const releases = await response.json();
  if (!response.ok) {
    throw new Error(`获取 Release 列表失败：${JSON.stringify(releases)}`);
  }
  const existing = Array.isArray(releases)
    ? releases.find((release) => release.tag_name === TAG)
    : undefined;
  if (existing) return existing;

  const createUrl = `${GITEE_API}/repos/${OWNER}/${REPO}/releases`;
  const createResponse = await fetch(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: token,
      tag_name: TAG,
      name: `Personal Agent ${versionLabel}`,
      body: `Personal Agent 桌面版 ${versionLabel}\n自动更新通道，请保持 tag 为 \`${TAG}\`，每次发版更新附件即可。`,
    }),
  });
  const created = await createResponse.json();
  if (!createResponse.ok) {
    throw new Error(`创建 Release 失败：${JSON.stringify(created)}`);
  }
  console.log(`已创建 Release：${TAG}（${created.html_url ?? ''}）`);
  return created;
}

async function uploadAttachment(token, releaseId, filePath) {
  const fileName = basename(filePath);
  const fileBuffer = await readFile(filePath);
  const form = new FormData();
  form.append('access_token', token);
  form.append('file', new Blob([fileBuffer]), fileName);

  const uploadUrl = `${GITEE_API}/repos/${OWNER}/${REPO}/releases/${releaseId}/attach_files`;
  const response = await fetch(uploadUrl, { method: 'POST', body: form });
  const result = await response.json().catch(() => ({}));
  if (response.ok) {
    console.log(`  ✓ 已上传：${fileName}`);
    return;
  }
  console.warn(`  ✗ 上传失败：${fileName}：${JSON.stringify(result)}`);
  console.warn('    同名附件可能已存在，请在 Gitee Release 页面删除旧附件后重试，或改为手动上传。');
}

async function main() {
  const token = process.env.GITEE_TOKEN;
  if (!token) {
    throw new Error('缺少 GITEE_TOKEN 环境变量（Gitee 私人令牌，仓库 -> 管理 -> 私人令牌）。');
  }
  if (!versionLabel) {
    throw new Error('缺少版本参数，用法：node scripts/upload-gitee.mjs v0.2.8');
  }

  const out = resolve(desktopDirectory, 'out');
  const artifacts = [
    resolve(out, `PersonalAgent-${versionLabel}-Setup.exe`),
    resolve(out, `PersonalAgent-${versionLabel}-Setup.exe.blockmap`),
    resolve(out, 'latest.yml'),
  ];
  for (const file of artifacts) {
    await requireFile(file);
  }

  console.log(`上传产物（${versionLabel}）到 Gitee Release：${OWNER}/${REPO} @ ${TAG}`);
  const release = await findOrCreateRelease(token);
  for (const file of artifacts) {
    await uploadAttachment(token, release.id, file);
  }

  console.log('');
  console.log(`更新通道就绪：https://gitee.com/${OWNER}/${REPO}/releases/download/${TAG}/`);
  console.log('用户端将自动检测到新版本并后台下载更新。');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
