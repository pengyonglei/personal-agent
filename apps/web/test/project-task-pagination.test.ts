import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextProjectTaskCount, paginateProjectTasks } from '../client/src/project-task-pagination';

test('project tasks reveal ten newest items per page until all are visible', () => {
  const tasks = Array.from({ length: 25 }, (_, index) => `task-${index + 1}`);

  const firstPage = paginateProjectTasks(tasks);
  assert.deepEqual(firstPage.tasks, tasks.slice(0, 10));
  assert.equal(firstPage.hasMore, true);

  const secondPageCount = nextProjectTaskCount(undefined, tasks.length);
  const secondPage = paginateProjectTasks(tasks, secondPageCount);
  assert.deepEqual(secondPage.tasks, tasks.slice(0, 20));
  assert.equal(secondPage.hasMore, true);

  const finalPageCount = nextProjectTaskCount(secondPageCount, tasks.length);
  const finalPage = paginateProjectTasks(tasks, finalPageCount);
  assert.deepEqual(finalPage.tasks, tasks);
  assert.equal(finalPage.hasMore, false);
  assert.equal(nextProjectTaskCount(finalPageCount, tasks.length), tasks.length);
});
