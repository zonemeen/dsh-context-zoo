/** A small executable coding task; acceptance cases are never sent to the model. */
export const taskId = 'invoice-import-v1';
export const editablePaths = ['src/policy.mjs', 'src/store.mjs', 'src/importer.mjs'];
export const initialFiles = {
  'README.md': `# Invoice import library

Implement this dependency-free JavaScript library using the requirements supplied in the conversation.
Only src/policy.mjs, src/store.mjs, and src/importer.mjs may be changed.

## Interfaces
- policy.mjs: export retentionMs and retryDelay(status, attempt). attempt is one-based; return a delay in milliseconds or null.
- store.mjs: export createStore(). Each store has lookup({tenantId, key, fingerprint, now}) and save({tenantId, key, fingerprint, response, now}).
- lookup returns {kind: 'miss'}, {kind: 'conflict'}, or {kind: 'hit', response}.
- importer.mjs: export async importInvoice(request, deps). request contains tenantId, key, fingerprint, and payload.
- deps contains store, now(), async send({headers, body}), and async wait(milliseconds).
- send and importInvoice return {status, body}. A conflict response is {status: 409, body: {error: 'idempotency_conflict'}}.
- A later stage adds async importBatch(requests, deps), returning an array of responses.

Use read_file to inspect files, write_file to replace a source file, and run_tests for the currently available development tests.
Dependencies, imports outside these three source files, filesystem access from the library, and network access are unavailable.
The development tests cover examples; independent acceptance cases also check regressions and boundary conditions.
`,
  'src/policy.mjs': `export const retentionMs = 24 * 60 * 60 * 1000;
export function retryDelay(status, attempt) {
  // TODO: implement the agreed retry policy.
  return null;
}
`,
  'src/store.mjs': `import { retentionMs } from './policy.mjs';
export function createStore() {
  return {
    lookup({ tenantId, key, fingerprint, now }) { return { kind: 'miss' }; },
    save({ tenantId, key, fingerprint, response, now }) { /* TODO */ },
  };
}
`,
  'src/importer.mjs': `import { retryDelay } from './policy.mjs';
export async function importInvoice(request, deps) {
  throw new Error('Not implemented');
}
export async function importBatch(requests, deps) {
  throw new Error('Not implemented');
}
`,
};

export const systemPrompt = `You are implementing a small JavaScript library in an isolated project. Work on the files using the supplied tools. Follow the user's latest requirements and retain requirements that have not been superseded. Read README.md and relevant source before editing. Run the development tests after your final edit in every stage. Finish a stage with a short factual status, distinguishing passed tests from work not yet verified. Tools operate only on the project; there is no shell. Do not substitute a prose answer for code changes.`;

export const phases = [
  { id: 'retry-policy', prompt: `Stage 1 of 4: inspect the project and implement retryDelay in src/policy.mjs. Retry only HTTP 429, 502, 503, and 504. Permit at most three attempts TOTAL, including the first; wait 250 ms before attempt 2 and 500 ms before attempt 3. Other statuses, including 500, are not retryable. Return null after the third attempt. Initially retain idempotency records for 24 hours.

Requirements for the later importer stages: the outgoing header must be exactly Idempotency-Key. Identity is the pair (tenantId, key), never key alone. A repeated matching fingerprint replays the original successful response without sending again; a different fingerprint for an unexpired identity returns the documented conflict response. Only HTTP 2xx responses may be cached. A transport exception must propagate without a retry or cache entry. Use injected time and wait functions; never real timers or networking. These requirements remain in effect throughout the task unless explicitly changed.

Implement only the policy in this stage and run_tests before finishing.` },
  { id: 'tenant-store', prompt: `Stage 2 of 4: correction: retention must be 48 hours, explicitly replacing the earlier 24-hour requirement. Update the policy and implement createStore in src/store.mjs using the README interface and the identity/replay rules agreed earlier. Entries expire exactly when now >= saved time + retentionMs. An expired entry behaves as a miss even if the new fingerprint differs. Tenant IDs and keys may themselves contain punctuation, so joining them with an unescaped delimiter is insufficient. Implement an in-memory store without dependencies. Run_tests after editing.` },
  { id: 'importer', prompt: `Stage 3 of 4: implement importInvoice in src/importer.mjs using the completed store and retry helper. Apply the header, identity, replay, conflict, success-cache, exception, and timing requirements agreed earlier. Use the README dependency interfaces. Return the final response unchanged, except for the documented conflict response. Leave batching for the next stage. Run_tests after editing.` },
  { id: 'batch-continuation', prompt: `Stage 4 of 4: continue the implementation by adding importBatch(requests, deps). Process requests sequentially, reuse importInvoice and the same dependency object, and return responses in input order. An HTTP failure response does not stop subsequent items; a thrown transport exception stops the batch and propagates. Preserve all previously agreed behavior, including the latest corrected policy. Complete regression fixes, run_tests after your final edit, then summarize the observed results.` },
];

// Bodies run in the same restricted JS context as the generated modules. Each
// case gets fresh module state so a previous case cannot populate another cache.
const cases = [
  ['retry-example', 1, false, `eq(policy.retryDelay(503, 1), 250); eq(policy.retryDelay(200, 1), null);`],
  ['retention-revision', 1, false, `eq(policy.retentionMs, ${24 * 60 * 60 * 1000});`],
  ['retry-all-statuses-and-attempts', 1, true, `for (const status of [429, 502, 503, 504]) { eq(policy.retryDelay(status, 1), 250); eq(policy.retryDelay(status, 2), 500); eq(policy.retryDelay(status, 3), null); eq(policy.retryDelay(status, 4), null); }`],
  ['permanent-statuses', 1, true, `for (const status of [200, 201, 400, 401, 403, 404, 408, 409, 500]) eq(policy.retryDelay(status, 1), null);`],
  ['store-replay', 2, false, `const s = store.createStore(); eq(s.lookup(identity), {kind:'miss'}); s.save({...identity, response}); eq(s.lookup(identity), {kind:'hit', response});`],
  ['tenant-isolation', 2, true, `const s = store.createStore(); s.save({...identity, response}); eq(s.lookup({...identity, tenantId:'other'}), {kind:'miss'});`],
  ['identity-delimiter-collision', 2, true, `const s = store.createStore(); s.save({...identity, tenantId:'a:b', key:'c', response}); eq(s.lookup({...identity, tenantId:'a', key:'b:c'}), {kind:'miss'});`],
  ['fingerprint-conflict', 2, true, `const s = store.createStore(); s.save({...identity, response}); eq(s.lookup({...identity, fingerprint:'different'}), {kind:'conflict'});`],
  ['retained-after-old-expiry', 2, true, `const s = store.createStore(); s.save({...identity, response}); eq(s.lookup({...identity, now:identity.now + 25*60*60*1000}), {kind:'hit', response});`],
  ['exact-expiry-and-reuse', 2, true, `const s = store.createStore(); s.save({...identity, response}); eq(s.lookup({...identity, now:identity.now + 48*60*60*1000 - 1}), {kind:'hit', response}); const later = {...identity, now:identity.now + 48*60*60*1000, fingerprint:'new'}; eq(s.lookup(later), {kind:'miss'}); s.save({...later, response:{status:201,body:'new'}}); eq(s.lookup(later), {kind:'hit', response:{status:201,body:'new'}});`],
  ['import-success', 3, false, `const f = fixture([response]); eq(await importer.importInvoice(request, f.deps), response); eq(f.sent.length, 1);`],
  ['header-and-payload', 3, true, `const f = fixture([response]); await importer.importInvoice(request, f.deps); eq(f.sent[0], {headers:{'Idempotency-Key':request.key},body:request.payload});`],
  ['retry-schedule', 3, true, `const f = fixture([{status:503,body:'busy'}, {status:429,body:'rate'}, response]); eq(await importer.importInvoice(request, f.deps), response); eq(f.waits,[250,500]); eq(f.sent.length,3);`],
  ['attempt-limit', 3, true, `const failed = {status:504,body:'unavailable'}; const f = fixture([failed,failed,failed,response]); eq(await importer.importInvoice(request,f.deps),failed); eq(f.sent.length,3); eq(f.waits,[250,500]);`],
  ['no-retry-on-500', 3, true, `const failed = {status:500,body:'permanent'}; const f=fixture([failed,response]); eq(await importer.importInvoice(request,f.deps),failed); eq(f.sent.length,1); eq(f.waits,[]);`],
  ['import-replay-and-conflict', 3, true, `const f=fixture([response]); await importer.importInvoice(request,f.deps); eq(await importer.importInvoice(request,f.deps),response); eq(await importer.importInvoice({...request,fingerprint:'changed'},f.deps),{status:409,body:{error:'idempotency_conflict'}}); eq(f.sent.length,1);`],
  ['import-tenant-isolation', 3, true, `const second={status:201,body:'tenant-b'}; const f=fixture([response,second]); await importer.importInvoice(request,f.deps); eq(await importer.importInvoice({...request,tenantId:'tenant-b'},f.deps),second); eq(f.sent.length,2);`],
  ['failed-response-not-cached', 3, true, `const f=fixture([{status:400,body:'invalid'},response]); await importer.importInvoice(request,f.deps); eq(await importer.importInvoice(request,f.deps),response); eq(f.sent.length,2);`],
  ['transport-exception-not-retried-or-cached', 3, true, `const f=fixture([new Error('connection lost'),response]); let caught=false; try { await importer.importInvoice(request,f.deps); } catch(e) { caught=e.message==='connection lost'; } eq(caught,true); eq(f.sent.length,1); eq(f.waits,[]); eq(await importer.importInvoice(request,f.deps),response); eq(f.sent.length,2);`],
  ['import-after-corrected-expiry', 3, true, `const second={status:201,body:'renewed'}; const f=fixture([response,second]); await importer.importInvoice(request,f.deps); f.time += 25*60*60*1000; eq(await importer.importInvoice(request,f.deps),response); f.time += 23*60*60*1000; eq(await importer.importInvoice(request,f.deps),second); eq(f.sent.length,2);`],
  ['batch-empty-and-order', 4, false, `const f=fixture([response,{status:201,body:'second'}]); eq(await importer.importBatch([],f.deps),[]); eq(await importer.importBatch([request,{...request,key:'second'}],f.deps),[response,{status:201,body:'second'}]);`],
  ['batch-sequential-and-replay', 4, true, `let active=0; let maximum=0; let calls=0; const f=fixture([]); f.deps.send=async () => { calls++; active++; maximum=Math.max(maximum,active); await Promise.resolve(); active--; return response; }; eq(await importer.importBatch([request,{...request,key:'second'},request],f.deps),[response,response,response]); eq(maximum,1); eq(calls,2);`],
  ['batch-continues-after-http-failure', 4, true, `const failure={status:400,body:'invalid'}; const f=fixture([failure,response]); eq(await importer.importBatch([request,{...request,key:'second'}],f.deps),[failure,response]); eq(f.sent.length,2);`],
  ['batch-stops-after-exception', 4, true, `const f=fixture([new Error('connection lost'),response]); let caught=false; try { await importer.importBatch([request,{...request,key:'second'}],f.deps); } catch(e) { caught=e.message==='connection lost'; } eq(caught,true); eq(f.sent.length,1);`],
];

export function taskCases(phase, acceptance = false) {
  if (!Number.isInteger(phase) || phase < 1 || phase > phases.length) throw new Error('Invalid task phase.');
  return cases.filter(([, start, hidden]) => start <= phase && (acceptance || !hidden)).map(([name, , , body]) => ({
    name, body: name === 'retention-revision' && phase >= 2 ? `eq(policy.retentionMs, ${48 * 60 * 60 * 1000});` : body,
  }));
}

export function caseSource(body) {
  return `import * as policy from './src/policy.mjs';
import * as store from './src/store.mjs';
import * as importer from './src/importer.mjs';
function eq(actual, expected) {
  const normalize = x => Array.isArray(x) ? x.map(normalize) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k,normalize(x[k])])) : x;
  if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) throw new Error('Expected '+JSON.stringify(expected)+'; got '+JSON.stringify(actual));
}
const identity = {tenantId:'tenant-a',key:'invoice-17',fingerprint:'fingerprint-a',now:1200};
const request = {tenantId:identity.tenantId,key:identity.key,fingerprint:identity.fingerprint,payload:{amount:1700,currency:'USD'}};
const response = {status:201,body:{invoiceId:'created-17'}};
function fixture(responses) {
  const f={sent:[],waits:[],time:1200};
  f.deps={store:store.createStore(),now:()=>f.time,wait:async ms=>{f.waits.push(ms);},send:async input=>{f.sent.push(input); const value=responses[f.sent.length-1]; if(value instanceof Error) throw value; if(!value) throw new Error('Unexpected extra send'); return value;}};
  return f;
}
${body}
export const passed = true;
`;
}
