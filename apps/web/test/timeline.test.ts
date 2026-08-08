import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantResponseId } from '../client/src/timeline';

test('assistant timeline ids stay unique across separate user prompts', () => {
  assert.notEqual(assistantResponseId(1), assistantResponseId(2));
  assert.notEqual(assistantResponseId(2), assistantResponseId(3));
});

test('assistant timeline ids stay stable within one user prompt', () => {
  assert.equal(assistantResponseId(4), assistantResponseId(4));
});
