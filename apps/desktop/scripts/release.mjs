import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const operations = new Set([
  'package',
  'make',
  'make-installer',
  'make-arm64',
  'make-installer-arm64',
  'publish',
  'upload',
]);

function parseArgs(args) {
  let operation = 'make';
  let version;

  if (args[0] && operations.has(args[0])) {
    operation = args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--') continue;

    if (argument === '--version' || argument === '-v') {
      const nextArgument = args[index + 1];
      if (!nextArgument || nextArgument.startsWith('-')) {
        throw new Error('--version 参数后需要提供版本号，例如 v0.1.2。');
      }
      version = nextArgument;
      index += 1;
      continue;
    }

    if (argument.startsWith('--version=')) {
      version = argument.slice('--version='.length);
      if (!version) {
        throw new Error('--version 参数后需要提供版本号，例如 v0.1.2。');
      }
      continue;
    }

    if (!argument.startsWith('-') && !version) {
      version = argument;
      continue;
    }

    throw new Error(`不支持的参数：${argument}`);
  }

  return { operation, version };
}

function normalizeVersion(value) {
  const trimmed = String(value ?? '').trim();
  const match =
    /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u.exec(
      trimmed,
    );

  if (!match) {
    throw new Error('版本号格式不正确，请使用类似 v0.1.2 的格式。');
  }

  return {
    value: match[1],
    label: `v${match[1]}`,
  };
}

async function resolveVersion(value) {
  const packageJson = JSON.parse(await readFile(resolve(desktopDirectory, 'package.json'), 'utf8'));
  const defaultVersion = normalizeVersion(packageJson.version);

  if (value) return normalizeVersion(value);

  if (!input.isTTY || !output.isTTY) {
    return defaultVersion;
  }

  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(
      `请输入桌面版版本号（直接回车使用 ${defaultVersion.label}）：`,
    );
    return answer.trim() ? normalizeVersion(answer) : defaultVersion;
  } finally {
    readline.close();
  }
}

function run(command, args, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: desktopDirectory,
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
      stdio: 'inherit',
      windowsHide: false,
    });

    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          `${command} ${args.join(' ')} 执行失败${signal ? `（${signal}）` : `（退出码 ${code ?? 'unknown'}）`}`,
        ),
      );
    });
  });
}

function runPnpm(args, env) {
  return run(packageManager, args, env);
}

function buildEnv() {
  return {
    // electron-builder 工具链（NSIS、winCodeSign 等）下载镜像，默认走 npmmirror 加速
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
      'https://npmmirror.com/mirrors/electron-builder-binaries/',
  };
}

async function buildRuntime() {
  await runPnpm(['run', 'prepare:chromium'], {});
  await runPnpm(['run', 'prepare:runtime'], {});
  await runPnpm(['run', 'build:production'], {});
}

/** 生成可运行目录（out/win-unpacked），对应原 Forge 的 package 阶段 */
async function packageApplication(arch, env) {
  await buildRuntime();
  await runPnpm(['exec', 'electron-builder', '--win', `--${arch}`, '--dir', env.versionArg], env);
}

/**
 * 生成 NSIS 安装包（out/PersonalAgent-vX.X.X-Setup.exe + latest.yml + blockmap）。
 * electron-builder 没有独立的 make 阶段，安装包必然完整重建，
 * 因此 make-installer / make-installer-arm64 语义为「完整构建安装包」。
 */
async function makeInstaller(arch, env) {
  await buildRuntime();
  await runPnpm(['exec', 'electron-builder', '--win', `--${arch}`, env.versionArg], env);
}

function printUploadInstructions(version) {
  const out = resolve(desktopDirectory, 'out');
  const setupExe = resolve(out, `PersonalAgent-v${version.value}-Setup.exe`);
  const blockmap = resolve(out, `PersonalAgent-v${version.value}-Setup.exe.blockmap`);
  const latestYml = resolve(out, 'latest.yml');

  console.log('');
  console.log('========================================================');
  console.log('构建完成。请将以下 3 个产物上传到 Gitee Release：');
  console.log(
    '  Release 地址：https://gitee.com/pengyonglei/personal-agent/releases/new?tag=latest',
  );
  console.log('  （每次发版都更新同一个 tag=latest 的 Release 附件）');
  console.log('');
  console.log(`  1. 安装包    ${setupExe}`);
  console.log(`  2. 差分块    ${blockmap}`);
  console.log(`  3. 更新元数据 ${latestYml}`);
  console.log('');
  console.log('上传完成后，用户端会自动检测到新版本并后台下载更新。');
  console.log('（也可运行 pnpm desktop:publish:upload 调用脚本自动上传，需配置 GITEE_TOKEN）');
  console.log('========================================================');
  console.log('');
}

async function main() {
  const { operation, version: versionArgument } = parseArgs(process.argv.slice(2));
  const version = await resolveVersion(versionArgument);
  const env = {
    ...buildEnv(),
    PERSONAL_AGENT_RELEASE_VERSION: version.label,
    // 版本注入：不修改 package.json，构建时覆盖生效版本（含产物名与更新元数据）
    versionArg: `-c.extraMetadata.version=${version.value}`,
  };

  console.log(`桌面版打包版本：${version.label}`);

  switch (operation) {
    case 'package':
      await packageApplication('x64', env);
      break;
    case 'make':
      await makeInstaller('x64', env);
      break;
    case 'make-installer':
      await makeInstaller('x64', env);
      break;
    case 'make-arm64':
      await makeInstaller('arm64', env);
      break;
    case 'make-installer-arm64':
      await makeInstaller('arm64', env);
      break;
    case 'publish':
      await makeInstaller('x64', env);
      printUploadInstructions(version);
      break;
    case 'upload': {
      const uploadScript = resolve(desktopDirectory, 'scripts', 'upload-gitee.mjs');
      await run(process.execPath, [uploadScript, version.label], env);
      break;
    }
    default:
      throw new Error(`不支持的打包操作：${operation}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
