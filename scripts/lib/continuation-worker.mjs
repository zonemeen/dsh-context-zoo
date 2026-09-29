/** Trusted test worker. Generated modules get no host globals or external imports. */
import vm from 'node:vm';
import { posix } from 'node:path';
import { getTask } from './continuation-tasks.mjs';

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 600_000) throw new Error('Worker input too large.');
}
const { files, phase, acceptance, taskId = 'invoice-import-v1' } = JSON.parse(raw);
const { taskCases, caseSource, editablePaths } = getTask(taskId);
const checks = [];
for (const test of taskCases(phase, acceptance)) {
  try {
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    const modules = new Map();
    const sources = { ...Object.fromEntries(editablePaths.map(path => [`/${path}`, files[path]])), '/case.mjs': caseSource(test.body) };
    const get = id => {
      if (!modules.has(id)) {
        if (typeof sources[id] !== 'string') throw new Error('Source module unavailable.');
        modules.set(id, new vm.SourceTextModule(sources[id], {
          context, identifier: id,
          importModuleDynamically() { throw new Error('Dynamic imports are unavailable.'); },
        }));
      }
      return modules.get(id);
    };
    const main = get('/case.mjs');
    await main.link((specifier, from) => {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error('Only project source imports are allowed.');
      const target = posix.resolve(posix.dirname(from.identifier), specifier);
      if (!editablePaths.some(path => target === `/${path}`)) throw new Error('Import outside project source.');
      return get(target);
    });
    await main.evaluate({ timeout: 500 });
    if (main.namespace.passed !== true) throw new Error('Case did not finish.');
    checks.push({ name: test.name, passed: true });
  } catch (error) { checks.push({ name: test.name, passed: false, error: String(error.message).slice(0, 500) }); }
}
process.stdout.write(JSON.stringify({ checks }));
