import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addTaskMarker,
  addUnreadTask,
  removeTaskMarker,
  removeUnreadTask,
  retainTaskMarkers,
  retainUnreadTasks,
} from '../client/src/task-unread';

test('only a completed background task becomes unread', () => {
  const empty = new Set<string>();
  assert.strictEqual(addUnreadTask(empty, 'task-a', 'task-a'), empty);
  assert.deepEqual([...addUnreadTask(empty, 'task-b', 'task-a')], ['task-b']);
});

test('opening an unread task clears its marker without mutating the previous set', () => {
  const unread = new Set(['task-a', 'task-b']);
  const next = removeUnreadTask(unread, 'task-a');
  assert.deepEqual([...unread], ['task-a', 'task-b']);
  assert.deepEqual([...next], ['task-b']);
  assert.strictEqual(removeUnreadTask(next, 'task-a'), next);
});

test('unread markers for deleted or archived tasks are removed', () => {
  const unread = new Set(['task-a', 'task-b']);
  assert.deepEqual([...retainUnreadTasks(unread, new Set(['task-b', 'task-c']))], ['task-b']);
});

test('task markers support the waiting-for-user lifecycle', () => {
  const empty = new Set<string>();
  const waiting = addTaskMarker(empty, 'task-a');
  assert.deepEqual([...waiting], ['task-a']);
  assert.strictEqual(addTaskMarker(waiting, 'task-a'), waiting);
  assert.deepEqual([...removeTaskMarker(waiting, 'task-a')], []);
  assert.deepEqual([...retainTaskMarkers(waiting, new Set(['task-b']))], []);
});
