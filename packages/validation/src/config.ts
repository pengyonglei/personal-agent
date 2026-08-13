import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';
import type {
  ValidationAction,
  ValidationAssertion,
  ValidationCommand,
  ValidationConfig,
  ValidationScenario,
} from './types';

/** 全局验证配置；对所有项目生效，命令中的相对路径仍以当前项目目录为基准。 */
export const VALIDATION_CONFIG_PATH = resolve(homedir(), '.personal-agent', 'validation.yaml');

export class ValidationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationConfigError';
  }
}

export async function loadValidationConfig(
  workingDirectory: string,
  configPath = VALIDATION_CONFIG_PATH,
): Promise<ValidationConfig> {
  const absolutePath = isAbsolute(configPath) ? configPath : resolve(workingDirectory, configPath);
  if (!existsSync(absolutePath)) {
    throw new ValidationConfigError(
      `Validation config not found: ${absolutePath}. Create the global config ${VALIDATION_CONFIG_PATH} first.`,
    );
  }
  let raw: unknown;
  try {
    raw = parse(await readFile(absolutePath, 'utf8')) as unknown;
  } catch (error) {
    throw new ValidationConfigError(`Cannot parse ${absolutePath}: ${formatError(error)}`);
  }
  return normalizeValidationConfig(raw);
}

export function normalizeValidationConfig(value: unknown): ValidationConfig {
  const root = object(value, 'configuration');
  if (root.version !== undefined && root.version !== 1) {
    throw new ValidationConfigError('Only validation configuration version 1 is supported.');
  }
  const server = object(root.server, 'server');
  const url = requiredString(server.url, 'server.url');
  ensureLocalUrl(url, 'server.url');
  const healthUrl = optionalString(server.healthUrl, 'server.healthUrl') ?? url;
  ensureLocalUrl(healthUrl, 'server.healthUrl');
  const browser = optionalObject(root.browser, 'browser');
  const viewport = optionalObject(browser.viewport, 'browser.viewport');
  const checks = optionalObject(root.checks, 'checks');
  const network = optionalObject(root.network, 'network');
  const consoleConfig = optionalObject(root.console, 'console');
  const artifacts = optionalObject(root.artifacts, 'artifacts');
  const vision = root.vision === undefined ? undefined : object(root.vision, 'vision');

  return {
    version: 1,
    server: {
      command: optionalString(server.command, 'server.command'),
      url,
      healthUrl,
      timeoutMs: positiveInteger(server.timeoutMs, 'server.timeoutMs', 60_000),
      reuseExisting: optionalBoolean(server.reuseExisting, 'server.reuseExisting', true),
      env: stringRecord(server.env, 'server.env'),
    },
    browser: {
      viewport: {
        width: positiveInteger(viewport.width, 'browser.viewport.width', 1440),
        height: positiveInteger(viewport.height, 'browser.viewport.height', 1000),
      },
      colorScheme: enumValue(
        browser.colorScheme,
        'browser.colorScheme',
        ['light', 'dark', 'no-preference'] as const,
        'light',
      ),
      locale: optionalString(browser.locale, 'browser.locale'),
      executablePath: optionalString(browser.executablePath, 'browser.executablePath'),
      headless: optionalBoolean(browser.headless, 'browser.headless', true),
    },
    checks: {
      quick: commandList(checks.quick, 'checks.quick'),
      full: commandList(checks.full, 'checks.full'),
    },
    scenarios: scenarioList(root.scenarios),
    network: {
      failOnRequestError: optionalBoolean(
        network.failOnRequestError,
        'network.failOnRequestError',
        true,
      ),
      failOnHttpStatus: positiveInteger(network.failOnHttpStatus, 'network.failOnHttpStatus', 500),
      ignore: stringList(network.ignore, 'network.ignore'),
    },
    console: {
      failOn: enumList(consoleConfig.failOn, 'console.failOn', ['error', 'warning'] as const, [
        'error',
      ]),
      ignore: stringList(consoleConfig.ignore, 'console.ignore'),
    },
    artifacts: {
      root: optionalString(artifacts.root, 'artifacts.root'),
      keepRuns: positiveInteger(artifacts.keepRuns, 'artifacts.keepRuns', 20),
      trace: enumValue(
        artifacts.trace,
        'artifacts.trace',
        ['off', 'retain-on-failure', 'on'] as const,
        'retain-on-failure',
      ),
    },
    vision: vision
      ? {
          enabled: optionalBoolean(vision.enabled, 'vision.enabled', false),
          provider: optionalString(vision.provider, 'vision.provider'),
          model: optionalString(vision.model, 'vision.model'),
          prompt: optionalString(vision.prompt, 'vision.prompt'),
        }
      : undefined,
  };
}

function scenarioList(value: unknown): ValidationScenario[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationConfigError('scenarios must contain at least one scenario.');
  }
  return value.map((item, index) => {
    const scenario = object(item, `scenarios[${index}]`);
    const profiles = enumList(
      scenario.profiles,
      `scenarios[${index}].profiles`,
      ['quick', 'full'] as const,
      ['quick', 'full'],
    );
    return {
      name: requiredString(scenario.name, `scenarios[${index}].name`),
      path: optionalString(scenario.path, `scenarios[${index}].path`) ?? '/',
      profiles,
      actions: actionList(scenario.actions, index),
      assertions: assertionList(scenario.assertions, index),
      screenshot:
        typeof scenario.screenshot === 'string' || typeof scenario.screenshot === 'boolean'
          ? scenario.screenshot
          : true,
    };
  });
}

function actionList(value: unknown, scenarioIndex: number): ValidationAction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationConfigError(`scenarios[${scenarioIndex}].actions must be an array.`);
  }
  return value.map((item, index) => {
    const action = object(item, `scenarios[${scenarioIndex}].actions[${index}]`);
    return {
      action: enumValue(action.action, `scenarios[${scenarioIndex}].actions[${index}].action`, [
        'click',
        'fill',
        'press',
        'check',
        'uncheck',
        'select',
        'wait',
      ] as const),
      ...locatorFields(action, `scenarios[${scenarioIndex}].actions[${index}]`),
      value: optionalString(action.value, 'action.value'),
      key: optionalString(action.key, 'action.key'),
      timeoutMs:
        action.timeoutMs === undefined
          ? undefined
          : positiveInteger(action.timeoutMs, 'action.timeoutMs', 5_000),
    };
  });
}

function assertionList(value: unknown, scenarioIndex: number): ValidationAssertion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationConfigError(`scenarios[${scenarioIndex}].assertions must be an array.`);
  }
  return value.map((item, index) => {
    const assertion = object(item, `scenarios[${scenarioIndex}].assertions[${index}]`);
    return {
      assert: enumValue(
        assertion.assert,
        `scenarios[${scenarioIndex}].assertions[${index}].assert`,
        ['visible', 'hidden', 'text', 'url', 'count'] as const,
      ),
      ...locatorFields(assertion, `scenarios[${scenarioIndex}].assertions[${index}]`),
      value: optionalString(assertion.value, 'assertion.value'),
      count:
        assertion.count === undefined
          ? undefined
          : nonNegativeInteger(assertion.count, 'assertion.count'),
    };
  });
}

function locatorFields(value: Record<string, unknown>, path: string) {
  const fields = {
    role: optionalString(value.role, `${path}.role`),
    name: optionalString(value.name, `${path}.name`),
    testId: optionalString(value.testId, `${path}.testId`),
    text: optionalString(value.text, `${path}.text`),
    selector: optionalString(value.selector, `${path}.selector`),
  };
  const count = Object.values(fields).filter(Boolean).length;
  if (count > 1 && !(fields.role && fields.name && count === 2)) {
    throw new ValidationConfigError(
      `${path} locator is ambiguous; use exactly one locator strategy.`,
    );
  }
  return fields;
}

function commandList(value: unknown, path: string): ValidationCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationConfigError(`${path} must be an array.`);
  return value.map((item, index) => {
    if (typeof item === 'string') return { command: requiredString(item, `${path}[${index}]`) };
    const command = object(item, `${path}[${index}]`);
    return {
      command: requiredString(command.command, `${path}[${index}].command`),
      timeoutMs: positiveInteger(command.timeoutMs, `${path}[${index}].timeoutMs`, 120_000),
    };
  });
}

function ensureLocalUrl(value: string, path: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationConfigError(`${path} must be a valid http(s) URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ValidationConfigError(`${path} must use http or https.`);
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new ValidationConfigError(`${path} must target localhost.`);
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationConfigError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, path: string): Record<string, unknown> {
  return value === undefined ? {} : object(value, path);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationConfigError(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, path);
}

function positiveInteger(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationConfigError(`${path} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationConfigError(`${path} must be a non-negative integer.`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ValidationConfigError(`${path} must be a boolean.`);
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
  fallback?: T[number],
): T[number] {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ValidationConfigError(`${path} must be one of: ${values.join(', ')}.`);
  }
  return value as T[number];
}

function enumList<const T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
  fallback: T[number][],
): T[number][] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new ValidationConfigError(`${path} must be an array.`);
  return value.map((item, index) => enumValue(item, `${path}[${index}]`, values));
}

function stringList(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationConfigError(`${path} must be an array.`);
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  const record = object(value, path);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    result[key] = requiredString(item, `${path}.${key}`);
  }
  return result;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
