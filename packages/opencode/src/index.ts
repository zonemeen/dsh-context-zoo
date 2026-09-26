/** OpenCode's independently owned context-management workflow. */
import { createContextPlugin } from '@dsh-context-zoo/core';
import { createPipeline } from './pipeline.js';
export { strategy } from './strategy.js';
export { createPipeline } from './pipeline.js';
export default createContextPlugin({ id: 'opencode', create: createPipeline });
