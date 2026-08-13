import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_VALIDATION_TOOL_NAMES,
  registerBuiltinTools,
  setBrowserValidationToolsEnabled,
} from '../src';

test('browser validation tools are disabled by default and can be toggled as a group', () => {
  const { registry } = registerBuiltinTools();

  for (const name of BROWSER_VALIDATION_TOOL_NAMES) {
    assert.equal(registry.get(name), undefined);
  }

  setBrowserValidationToolsEnabled(registry, true);
  for (const name of BROWSER_VALIDATION_TOOL_NAMES) assert.ok(registry.get(name));

  setBrowserValidationToolsEnabled(registry, false);
  for (const name of BROWSER_VALIDATION_TOOL_NAMES) {
    assert.equal(registry.get(name), undefined);
  }
});

test('browser validation tools are registered when explicitly enabled', () => {
  const { registry } = registerBuiltinTools({ browserValidationEnabled: true });
  assert.deepEqual(
    BROWSER_VALIDATION_TOOL_NAMES.filter((name) => registry.get(name)),
    [...BROWSER_VALIDATION_TOOL_NAMES],
  );
});
