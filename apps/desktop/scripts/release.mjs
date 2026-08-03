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

async function packageApplication(arch, env) {
  await runPnpm(['run', 'prepare:runtime'], env);
  await runPnpm(['run', 'build:production'], env);
  await runPnpm(['exec', 'electron-forge', 'package', '--platform=win32', `--arch=${arch}`], env);
}

async function makeInstaller(arch, env) {
  await runPnpm(
    ['exec', 'electron-forge', 'make', '--skip-package', '--platform=win32', `--arch=${arch}`],
    env,
  );
}

async function main() {
  const { operation, version: versionArgument } = parseArgs(process.argv.slice(2));
  const version = await resolveVersion(versionArgument);
  const env = {
    PERSONAL_AGENT_RELEASE_VERSION: version.label,
  };

  console.log(`桌面版打包版本：${version.label}`);

  switch (operation) {
    case 'package':
      await packageApplication('x64', env);
      break;
    case 'make':
      await packageApplication('x64', env);
      await makeInstaller('x64', env);
      break;
    case 'make-installer':
      await makeInstaller('x64', env);
      break;
    case 'make-arm64':
      await packageApplication('arm64', env);
      await makeInstaller('arm64', env);
      break;
    case 'make-installer-arm64':
      await makeInstaller('arm64', env);
      break;
    default:
      throw new Error(`不支持的打包操作：${operation}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
