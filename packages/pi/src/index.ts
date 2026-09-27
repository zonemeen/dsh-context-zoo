/** Context management plugin based on the Pi workflow. */
import { createContextPlugin } from 'dsh-context-core';
import { createPipeline } from './pipeline.js';
export { strategy } from './strategy.js';
export { createPipeline } from './pipeline.js';
export default createContextPlugin({ id: 'pi', create: createPipeline });
