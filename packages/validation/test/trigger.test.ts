import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrontendValidationGate, isFrontendFile } from '../src/trigger';

test('detects visible frontend files without triggering on arbitrary backend TypeScript', () => {
  assert.equal(isFrontendFile('apps/web/client/src/App.tsx'), true);
  assert.equal(isFrontendFile('src/components/header.ts'), true);
  assert.equal(isFrontendFile('packages/core/src/agent-loop.ts'), false);
  assert.equal(isFrontendFile('styles/theme.css'), true);
});

test('requires validation once per change and caps retries at initial plus two rechecks', () => {
  const gate = new FrontendValidationGate();
  gate.recordFile('src/App.tsx');
  assert.match(gate.requiredFollowup() ?? '', /frontend_validate/);
  assert.match(
    gate.requiredFollowup() ?? '',
    /frontend_validate/,
    'the agent may not finish by ignoring the validation requirement',
  );

  gate.recordValidation(false);
  assert.match(gate.requiredFollowup() ?? '', /2 more validation attempt/);
  gate.recordValidation(false);
  assert.match(gate.requiredFollowup() ?? '', /1 more validation attempt/);
  gate.recordValidation(false);
  assert.equal(gate.requiredFollowup(), undefined);
});

test('successful validation suppresses the gate until another frontend file changes', () => {
  const gate = new FrontendValidationGate();
  gate.recordFile('src/App.tsx');
  gate.recordValidation(true);
  assert.equal(gate.needsValidation(), false);
  gate.recordFile('src/App.tsx');
  assert.equal(
    gate.needsValidation(),
    true,
    'editing the same file again creates a new fingerprint',
  );
  gate.recordValidation(true);
  gate.recordFile('src/theme.css');
  assert.equal(gate.needsValidation(), true);
});

test('reset clears pending frontend validation work', () => {
  const gate = new FrontendValidationGate();
  gate.recordFile('src/components/App.tsx');
  assert.equal(gate.needsValidation(), true);

  gate.reset();

  assert.equal(gate.needsValidation(), false);
  assert.equal(gate.requiredFollowup(), undefined);
});
