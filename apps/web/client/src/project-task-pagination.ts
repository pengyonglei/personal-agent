export const PROJECT_TASK_PAGE_SIZE = 10;

export function paginateProjectTasks<T>(
  tasks: readonly T[],
  visibleCount = PROJECT_TASK_PAGE_SIZE,
): { tasks: T[]; hasMore: boolean } {
  const normalizedCount = Math.max(PROJECT_TASK_PAGE_SIZE, visibleCount);
  const visibleTasks = tasks.slice(0, normalizedCount);
  return {
    tasks: visibleTasks,
    hasMore: visibleTasks.length < tasks.length,
  };
}

export function nextProjectTaskCount(current: number | undefined, total: number): number {
  return Math.min(total, (current ?? PROJECT_TASK_PAGE_SIZE) + PROJECT_TASK_PAGE_SIZE);
}
