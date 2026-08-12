/** 后台任务完成时将其标记为未读；当前正在查看的任务不产生未读。 */
export function addUnreadTask(
  current: Set<string>,
  taskId: string,
  activeTaskId?: string,
): Set<string> {
  return taskId === activeTaskId ? current : addTaskMarker(current, taskId);
}

/** 向任务状态集合添加任务，保持不可变更新。 */
export function addTaskMarker(current: Set<string>, taskId: string): Set<string> {
  if (current.has(taskId)) return current;
  return new Set([...current, taskId]);
}

/** 从任务状态集合移除任务，保持不可变更新。 */
export function removeTaskMarker(current: Set<string>, taskId: string): Set<string> {
  if (!current.has(taskId)) return current;
  const next = new Set(current);
  next.delete(taskId);
  return next;
}

/** 清理已经不存在的任务状态。 */
export function retainTaskMarkers(
  current: Set<string>,
  existingTaskIds: ReadonlySet<string>,
): Set<string> {
  const next = new Set([...current].filter((taskId) => existingTaskIds.has(taskId)));
  return next.size === current.size ? current : next;
}

/** 进入任务后清除未读；没有变化时复用原 Set，避免无效渲染。 */
export function removeUnreadTask(current: Set<string>, taskId: string): Set<string> {
  return removeTaskMarker(current, taskId);
}

/** 任务被归档或删除后，清理已不存在任务的未读记录。 */
export function retainUnreadTasks(
  current: Set<string>,
  existingTaskIds: ReadonlySet<string>,
): Set<string> {
  return retainTaskMarkers(current, existingTaskIds);
}
