import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  normalizeValidationConfig,
  VALIDATION_CONFIG_PATH,
  ValidationConfigError,
} from '../src/config';
import { validationExitCode } from '../src/runner';

test('uses the global personal-agent validation configuration by default', () => {
  assert.equal(
    VALIDATION_CONFIG_PATH,
    resolve(homedir(), '.personal-agent', 'validation.yaml'),
  );
});

test('normalizes a minimal validation configuration', () => {
  const config = normalizeValidationConfig({
    version: 1,
    server: { url: 'http://127.0.0.1:3000' },
    scenarios: [{ name: 'home' }],
  });
  assert.deepEqual(config.browser.viewport, { width: 1440, height: 1000 });
  assert.equal(config.server.healthUrl, 'http://127.0.0.1:3000');
  assert.equal(config.scenarios[0].screenshot, true);
  assert.deepEqual(config.scenarios[0].profiles, ['quick', 'full']);
});

test('rejects external URLs and ambiguous locators', () => {
  assert.throws(
    () =>
      normalizeValidationConfig({
        server: { url: 'https://example.com' },
        scenarios: [{ name: 'home' }],
      }),
    ValidationConfigError,
  );
  assert.throws(
    () =>
      normalizeValidationConfig({
        server: { url: 'http://localhost:3000' },
        scenarios: [
          {
            name: 'home',
            actions: [{ action: 'click', testId: 'one', selector: '#one' }],
          },
        ],
      }),
    /ambiguous/,
  );
});

test('maps CLI exit codes for CI-ready behavior', () => {
  assert.equal(validationExitCode('passed'), 0);
  assert.equal(validationExitCode('failed'), 1);
  assert.equal(validationExitCode('infrastructure_error'), 2);
});
