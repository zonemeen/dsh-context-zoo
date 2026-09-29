/** Reference code used only to validate the evaluator, never in a model prompt. */
export function referenceFiles(phase = 4) {
  return {
    'src/policy.mjs': `export const retentionMs = ${phase === 1 ? 24 : 48} * 60 * 60 * 1000;
export function retryDelay(status, attempt) {
  return [429,502,503,504].includes(status) && attempt >= 1 && attempt < 3 ? [250,500][attempt-1] : null;
}

`,
    'src/store.mjs': `import {retentionMs} from './policy.mjs';
export function createStore() {
  const entries = new Map();
  const identity = x => JSON.stringify([x.tenantId,x.key]);
  return {
    lookup(input) {
      const entry=entries.get(identity(input));
      if (!entry || input.now >= entry.expiresAt) return {kind:'miss'};
      if (entry.fingerprint !== input.fingerprint) return {kind:'conflict'};
      return {kind:'hit',response:entry.response};
    },
    save(input) { entries.set(identity(input),{fingerprint:input.fingerprint,response:input.response,expiresAt:input.now+retentionMs}); }
  };
}
`,
    'src/importer.mjs': `import {retryDelay} from './policy.mjs';
export async function importInvoice(request,deps) {
  const prior=deps.store.lookup({...request,now:deps.now()});
  if(prior.kind==='hit') return prior.response;
  if(prior.kind==='conflict') return {status:409,body:{error:'idempotency_conflict'}};
  for(let attempt=1;;attempt++) {
    const response=await deps.send({headers:{'Idempotency-Key':request.key},body:request.payload});
    if(response.status>=200 && response.status<300) { deps.store.save({...request,response,now:deps.now()}); return response; }
    const delay=retryDelay(response.status,attempt);
    if(delay===null) return response;
    await deps.wait(delay);
  }
}
export async function importBatch(requests,deps) {
  ${phase < 4 ? "throw new Error('Not implemented');" : 'const responses=[]; for(const request of requests) responses.push(await importInvoice(request,deps)); return responses;'}
}
`,
  };
}

export function extendedReferenceFiles(phase = 10) {
  const files = referenceFiles(Math.min(phase, 4));
  if (phase >= 5) files['src/store.mjs'] = files['src/store.mjs'].replace('    save(input)', `    remove(input) { return entries.delete(identity(input)); },\n    save(input)`);
  if (phase >= 6) files['src/store.mjs'] = files['src/store.mjs'].replace('    save(input)', `    prune(now) { let count=0; for(const [key,entry] of entries) if(now>=entry.expiresAt) { entries.delete(key); count++; } return count; },\n    save(input)`);
  if (phase >= 7) files['src/importer.mjs'] = files['src/importer.mjs'].replace("if(prior.kind==='hit')", "if(prior.kind==='hit' && !request.forceRefresh)");
  if (phase >= 8) files['src/importer.mjs'] = files['src/importer.mjs']
    .replace('importBatch(requests,deps)', 'importBatch(requests,deps,options={})')
    .replace('for(const request of requests) responses.push(await importInvoice(request,deps));', 'for(const request of requests) { const response=await importInvoice(request,deps); responses.push(response); if(options.stopOnHttpFailure && !(response.status>=200 && response.status<300)) break; }');
  if (phase >= 9) {
    files['src/policy.mjs'] = files['src/policy.mjs'].replace('retryDelay(status, attempt)', 'retryDelay(status, attempt, retryAfterMs)').replace('  return [429', '  if ([429,502,503,504].includes(status) && attempt>=1 && attempt<3 && typeof retryAfterMs===\'number\' && Number.isFinite(retryAfterMs) && retryAfterMs>=0 && retryAfterMs<=60000) return retryAfterMs;\n  return [429');
    files['src/importer.mjs'] = files['src/importer.mjs'].replace('retryDelay(response.status,attempt)', 'retryDelay(response.status,attempt,response.retryAfterMs)');
  }
  if (phase >= 10) files['src/importer.mjs'] = files['src/importer.mjs'].replace('for(const request of requests) {', "for(const request of requests) { if(options.signal?.aborted) throw new Error('Batch aborted');");
  return files;
}
