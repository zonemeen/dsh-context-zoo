import * as shortTask from './continuation-task.mjs';
import * as extendedTask from './continuation-task-v2.mjs';

export const taskIds = [shortTask.taskId, extendedTask.taskId];
export function getTask(id = extendedTask.taskId) {
  if (id === shortTask.taskId) return { ...shortTask, compactAfter: [1, 2, 3] };
  if (id === extendedTask.taskId) return extendedTask;
  throw new Error('Unknown continuation task.');
}
