import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantTurnId } from '../client/src/timeline';

test('assistant timeline ids stay unique across separate user prompts', () => {
  assert.notEqual(assistantTurnId(1, 1), assistantTurnId(2, 1));
  assert.notEqual(assistantTurnId(2, 1), assistantTurnId(3, 1));
});

test('assistant timeline ids stay stable within one model turn', () => {
  assert.equal(assistantTurnId(4, 2), assistantTurnId(4, 2));
});
