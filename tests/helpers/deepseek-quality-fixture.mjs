/** Synthetic coding history and deterministic recall scoring for real-model compaction checks. */
import { ToolCallId, createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';

const tools = [
  { name: 'read', description: 'Read one project file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'shell', description: 'Run a local project command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

const originalImplementation = `Historical source: src/invoices/import-invoice.ts
The initial implementation used a 24-hour idempotency retention period. This is the old behavior being reviewed, not the final requirement.

import type { InvoiceDraft, ImportDependencies, ImportResult } from './types.js';
import { validateInvoiceDraft } from './validate-invoice.js';

export async function importInvoice(input: InvoiceDraft, dependencies: ImportDependencies): Promise<ImportResult> {
  const validation = validateInvoiceDraft(input);
  if (!validation.ok) return { kind: 'invalid', issues: validation.issues };
  const prepared = {
    externalId: input.externalId.trim(),
    tenant: input.tenant,
    currency: input.currency.toUpperCase(),
    lines: input.lines.map(line => ({ ...line, description: line.description.trim() })),
    receivedAt: dependencies.clock.now(),
  };
  const existing = await dependencies.store.findByExternalId(prepared.externalId);
  if (existing) return { kind: 'duplicate', invoiceId: existing.id };
  const response = await dependencies.gateway.submit(prepared);
  if (response.kind === 'rejected') return { kind: 'rejected', message: response.message };
  const record = await dependencies.store.insert({ ...prepared, remoteId: response.remoteId });
  return { kind: 'imported', invoiceId: record.id };
}

// The controller parses the body once and passes typed values into this module.
// Existing validation returns field-level problems without throwing transport errors.
// The storage adapter owns transaction opening, committing, and rollback.
// The gateway adapter owns response parsing and returns a tagged result.

export interface InvoiceDraft {
  tenant: string;
  externalId: string;
  currency: string;
  lines: readonly InvoiceLine[];
  reference?: string;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  accountCode: string;
}

export type ImportResult =
  | { kind: 'imported'; invoiceId: string }
  | { kind: 'duplicate'; invoiceId: string }
  | { kind: 'invalid'; issues: readonly ValidationIssue[] }
  | { kind: 'rejected'; message: string };

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

Observed implementation notes:
- The early duplicate lookup is only an optimization; simultaneous imports can both pass it.
- A transport exception currently skips the domain result conversion and reaches the controller.
- Validation precedes network access, so invalid requests do not reach the external gateway.
- Currency normalization is applied before building the gateway request.
- The storage adapter is dependency-injected, and integration tests use an in-memory fake.
- A failed insertion must not be reported as a completed import.
- The caller supplies cancellation; future wait operations must observe that same signal.
- The request body's reference is optional and must remain distinct from the external identifier.
- Empty descriptions are rejected by validation before this function runs.
- Monetary values use integer minor units throughout the existing domain model.
- A repeated request should return the original successful result when its identity matches.
- The current controller preserves the response envelope expected by its clients.
`;

const finalRequirements = `Final approved requirements, revision B:
- Idempotency entries expire after 48 hours. This explicitly supersedes the earlier 24-hour value.
- The request header is exactly Idempotency-Key.
- Retry only HTTP statuses 429, 502, 503, and 504.
- There are at most 3 attempts TOTAL, including the first attempt, not three retries.
- Wait 250 ms before the second attempt and 500 ms before the third attempt. No fourth attempt.
- Do not contact production and do not apply any database migration during this task.

Review discussion:
The imported invoice and the idempotency response record have different responsibilities. An invoice is a domain record, while the response record allows a client that lost its connection to recover the same outcome. Their identities should not be collapsed into one database column. The response record should retain enough response metadata for replay, while invoice storage remains responsible for normalized monetary values and line items.

The retry operation belongs inside the gateway adapter. The controller should not need a second retry loop, and the invoice repository should not know about HTTP statuses. The adapter must return a structured failure once its permitted attempts are exhausted. A caller cancellation should interrupt a pending delay and should stop subsequent requests. Validation failures remain local failures and do not enter the retry sequence.

The implementation should distinguish a response that explicitly reports a transient gateway condition from a successful response whose payload is malformed. A malformed success response is a parsing failure and is not automatically eligible for the same recovery path. Authentication failures and permanent client errors should reach the caller without repeated requests. The existing response envelope is retained so UI consumers can continue to render domain errors in the same place.

The response replay path must resolve the current request's ownership before returning any cached result. The cache entry contains a successful response, creation time, expiration time, and the normalized request fingerprint. Reusing an identity for a different normalized request must produce a deterministic conflict instead of silently returning unrelated work. Cancellation after a successful remote response is an uncertain remote outcome and should not be relabeled as a definite remote rejection.

Implementation review checklist:
- Keep domain validation separate from transport classification.
- Use the injected clock for deterministic expiration tests.
- Keep wait operations cancellable, and release listeners after completion.
- Return the original successful response for an identical replay.
- Keep numeric monetary values in integer minor units.
- Preserve the distinction between absent references and empty references.
- Leave the existing controller error envelope unchanged.
- Record which request attempt produced the final observed response.
- Do not introduce another background maintenance service for this change.
- Treat all sample identifiers in this transcript as synthetic test data.
`;

const proposedPatch = `Reviewed working-tree patch:
The uniqueness key is the pair tenant_id + external_invoice_id.
The migration file has been authored at migrations/20260926_invoice_import.sql. It has NOT been applied.

--- a/src/invoices/invoice-repository.ts
+++ b/src/invoices/invoice-repository.ts
@@
-export async function findInvoice(externalId: string) {
-  return database.invoice.findFirst({ where: { externalInvoiceId: externalId } });
+export async function findInvoice(tenantId: string, externalId: string) {
+  return database.invoice.findFirst({
+    where: { tenantId, externalInvoiceId: externalId },
+  });
 }
@@
-export async function saveInvoice(input: PreparedInvoice) {
-  return database.invoice.create({ data: input });
+export async function saveInvoice(input: PreparedInvoice) {
+  return database.transaction(async tx => {
+    const record = await tx.invoice.create({ data: input });
+    await tx.invoiceLine.createMany({
+      data: input.lines.map(line => ({ ...line, invoiceId: record.id })),
+    });
+    return record;
+  });
 }

--- a/src/invoices/import-controller.ts
+++ b/src/invoices/import-controller.ts
@@
-const prepared = parseInvoiceBody(request.body);
+const prepared = parseInvoiceBody(request.body);
+const identity = parseRequestIdentity(request.headers);
+const fingerprint = fingerprintInvoice(prepared);
+const previous = await responseStore.lookup({
+  owner: request.tenant,
+  identity,
+});
+if (previous && previous.fingerprint !== fingerprint) {
+  return conflictResponse('The request identity was reused for a different invoice.');
+}
+if (previous && previous.expiresAt > clock.now()) {
+  return replayResponse(previous.response);
+}
+const result = await importer.import(prepared, { signal: request.signal });
+if (result.kind === 'imported') {
+  await responseStore.save({
+    owner: request.tenant,
+    identity,
+    fingerprint,
+    response: successfulResponse(result),
+    createdAt: clock.now(),
+    expiresAt: clock.now() + policy.retentionMilliseconds,
+  });
+}
+return renderImportResult(result);

--- a/src/invoices/fingerprint.ts
+++ b/src/invoices/fingerprint.ts
@@
+export function fingerprintInvoice(invoice: ParsedInvoice): string {
+  return stableHash({
+    externalId: invoice.externalId,
+    currency: invoice.currency,
+    reference: invoice.reference ?? null,
+    lines: invoice.lines.map(line => ({
+      description: line.description,
+      quantity: line.quantity,
+      unitPriceMinor: line.unitPriceMinor,
+      accountCode: line.accountCode,
+    })),
+  });
+}

Reviewer notes:
The controller now has explicit stages for parsing, replay lookup, domain work, and response persistence. The replay branch does not call the invoice importer. Fingerprint construction is centralized so identical inputs cannot take different paths depending on property insertion order. A fingerprint mismatch returns a conflict before any remote request. This transcript records a proposed patch and local review; deployment is outside the authorized task.

The migration uses the existing schema's naming conventions and leaves unrelated indexes intact. The author checked that the two ownership columns are non-null before adding the new uniqueness rule. Backfill behavior is outside this patch because the current fixture database contains no legacy duplicate records. A real deployment still requires the repository's normal migration review and operator procedure.
`;

const gatewayImplementation = `Reviewed source: src/invoices/gateway-client.ts
The gateway adapter now implements the approved finite attempt schedule; this review does not add a second retry loop above it.

import type { GatewayRequest, GatewayResult, GatewayDependencies } from './gateway-types.js';

export async function submitInvoice(
  request: GatewayRequest,
  dependencies: GatewayDependencies,
  signal: AbortSignal,
): Promise<GatewayResult> {
  const policy = dependencies.policy;
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < policy.attemptLimit; attempt++) {
    signal.throwIfAborted();
    if (attempt > 0) {
      await dependencies.wait(policy.delays[attempt - 1], signal);
    }
    const response = await dependencies.transport.send(request, signal);
    lastStatus = response.status;
    if (response.ok) {
      const decoded = dependencies.decode(response.body);
      return decoded.ok
        ? { kind: 'accepted', remoteId: decoded.remoteId }
        : { kind: 'invalid-response', issues: decoded.issues };
    }
    if (!policy.transientStatuses.has(response.status)) {
      return { kind: 'rejected', status: response.status, body: response.body };
    }
  }
  return { kind: 'exhausted', lastStatus };
}

export async function cancellableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(signal.reason);
    const timer = setTimeout(() => finish(), milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

Adapter review observations:
The wait helper removes its cancellation listener after either success or failure, and it clears the timer when cancellation wins. The adapter checks cancellation before starting an attempt, including the initial attempt. Success and permanent rejections return from the loop immediately. The final exhausted result preserves the last response status for the caller's error presentation.

The transport fake used in the tests returns queued responses without opening a network connection. The clock fake advances only when explicitly requested by a test. Test cases record both sent requests and requested delays so the assertion can distinguish total attempts from additional retries. The response decoder is a separate dependency, allowing malformed response handling to be checked without introducing a real server.

Cases reviewed for lifecycle behavior:
A signal cancelled before admission must produce no sent request. A signal cancelled during a delay must prevent the next request. A completed delay must not leave its abort listener attached. A successful early response must not consume later queued responses. A permanent error must not schedule another delay. Exhaustion must preserve the last status, while a malformed success body must preserve its decoding issues. Unexpected transport exceptions are surfaced as their original failure rather than converted into a successful domain result.
`;

const validationCases = [
  ['empty invoice identifier', 'The parser rejects an identifier containing only whitespace, before repository lookup or gateway submission. The field issue names the external identifier without including the full submitted document.'],
  ['currency normalization', 'Lowercase currency input is normalized before fingerprinting and gateway serialization. The normalized draft is shared by both stages so a replay does not depend on the original letter case.'],
  ['integer monetary values', 'Line amounts use integer minor units. The fixture includes zero-value and high-value examples to distinguish valid integer arithmetic from floating point rounding during serialization.'],
  ['line ordering', 'The request fingerprint preserves invoice line order. Changing line order produces a different normalized document, while object property ordering does not change the fingerprint.'],
  ['optional reference', 'An omitted reference is normalized consistently. The test separately observes an explicitly present reference to ensure request identity is not accidentally inferred from an optional display field.'],
  ['duplicate reply replay', 'An identical repeat request receives the stored successful response. The fake importer records no additional invocation, and the response status and body match the first successful import.'],
  ['fingerprint conflict', 'Reusing a request identity with changed line content returns a conflict. No new invoice is written and no request reaches the gateway fake, preserving the recorded result for the original document.'],
  ['expired reply', 'The injected clock moves past the recorded expiration and lookup treats the entry as unavailable. The next successful request produces a new response record using the current normalized draft.'],
  ['transaction rollback', 'A failed line insertion rolls back invoice creation. The storage fake records the transaction failure, and the controller does not create a response replay record for work that did not commit.'],
  ['early cancellation', 'A signal cancelled before gateway admission prevents transport use. The test asserts the original cancellation reason and verifies that no response replay record is written after cancellation.'],
  ['cancelled delay', 'A signal cancelled while waiting prevents a subsequent request. Timer and listener tracking return to their initial counts when the promise settles, avoiding leaked resources in later cases.'],
  ['permanent rejection', 'An ordinary client rejection returns immediately. The fake wait dependency records no delay, and the controller preserves the established error envelope rather than adding transport internals.'],
  ['malformed successful body', 'A successful HTTP response with invalid domain content returns a decoding failure. The importer does not write an invoice whose required remote identity could not be decoded.'],
  ['eventual success', 'The transport queue contains transient responses followed by a valid success. Only admitted requests are consumed, and no delay is scheduled after the successful response has been decoded.'],
  ['exhausted attempts', 'The transport queue remains transient for the entire permitted schedule. The adapter returns the final observed status and does not consume the spare response left at the end of the queue.'],
  ['controller response stability', 'The import controller returns the established domain envelope for every settled outcome. Presentation fields remain independent of internal repository and transport implementation details.'],
  ['stable fixture cleanup', 'The local store and transport fake are recreated for each case. Cleanup checks timers, listeners, and pending operations so no case can make the following case pass through shared mutable state.'],
];

const localVerification = `Recorded local verification in this synthetic development session:
Command: pnpm test -- invoice-import
Result: 17 passed, 1 skipped, 0 failed.
The skipped case covers a real external gateway and requires separate credentials. It was not executed.
The next unfinished task is to ADD a tenant isolation regression test. Do not mistake the existing same-tenant replay tests for coverage of this missing case.
The current work authorization still forbids contacting production and applying the migration.

${validationCases.map(([name, details], index) => `PASS ${String(index + 1).padStart(2, '0')}: ${name}\n${details}`).join('\n\n')}

SKIP 18: real gateway integration; external test credentials are unavailable.
No skipped case is counted as a passing test. This local test run supports the implemented paths above, while the missing regression remains an explicit follow-up. The migration file was inspected as text; no schema change was applied to any database.
`;

const finalUserRequest = `Continue from the current handoff and finish the remaining local work. Before making the next change, inspect the earlier decisions and the latest observed verification result so that you do not repeat work that is already finished or silently change an accepted requirement. Keep the patch focused on the remaining gap, preserve the surrounding public behavior, and use the existing test style when adding coverage. A previous proposal may have been superseded by a later decision, so resolve any disagreement using the most recent explicit requirement recorded in the conversation.

When you report the outcome, distinguish what has been implemented from what has only been planned, and distinguish an observed successful check from a check that could not run. Include the exact references needed for someone else to continue the work. If a necessary fact is missing from the available context, say that it is unavailable instead of inventing a value. Keep your explanation short enough to review, but retain the concrete information required to carry out the next action correctly.

Use the existing ownership boundaries for validation, transport, persistence, and presentation. Recheck any assumption that affects how repeated requests behave. Avoid unrelated formatting changes, broad refactors, or additional infrastructure. Work from the recorded state of the task and leave a clear account of any unresolved item after the next local verification step.`;

/** Append a closed, tool-paired synthetic session without executing any represented operation. */
export function seedQualityConversation(session, { provider, model, maxTokens = 2048 }) {
  const stages = [
    { request: 'Inspect the invoice import flow and identify the areas that need an idempotency and recovery update.', path: 'src/invoices/import-invoice.ts', output: originalImplementation, conclusion: 'The original code has a global duplicate lookup and no finite transport recovery policy. I will resolve the final requirements before changing behavior.' },
    { request: 'Read the updated task requirements and use the final approved decisions when preparing the implementation.', path: 'docs/invoice-import-review.md', output: finalRequirements, conclusion: 'The final retention is 48 hours, superseding 24 hours. The finite retry schedule allows three attempts in total. The work stays local: no production contact and no migration execution.' },
    { request: 'Review the working-tree repository and controller changes, including the schema artifact.', path: 'reviews/invoice-import.diff', output: proposedPatch, conclusion: 'The repository now uses the tenant and external invoice identifier together. The migration has only been authored and inspected. Request replay and fingerprint conflict handling are present in the reviewed patch.' },
    { request: 'Check the gateway adapter and cancellation behavior before considering the implementation verified.', path: 'src/invoices/gateway-client.ts', output: gatewayImplementation, conclusion: 'The gateway owns the retry loop. Cancellation is propagated through the waits, and successful responses stop the loop. The next step is focused local verification.' },
    { request: 'Record the local verification result and identify any remaining coverage gap.', command: 'pnpm test -- invoice-import', output: localVerification, conclusion: 'The recorded command completed with 17 passed and 1 skipped. The external gateway case was not executed. Adding a tenant isolation regression is still pending; the migration remains unapplied.' },
  ];
  stages.forEach((stage, index) => {
    const turn = index + 1;
    const callId = ToolCallId(`quality-${turn}`);
    const name = stage.command ? 'shell' : 'read';
    const args = JSON.stringify(stage.command ? { command: stage.command } : { path: stage.path });
    session.append('turn/start', { turn });
    if (turn === 1) session.append('system/message', { turn, step: 1, message: createSystemMessage('You are continuing a synthetic coding task. Treat the recorded conversation as evidence, preserve decisions and unresolved work, and distinguish observed outcomes from assumptions.') }, { surfaceOp: 'append' });
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: stage.request }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    session.append('step/start', { turn, step: 1 });
    if (turn === 1) session.append('request/header', { header: { config: { provider, model, maxTokens }, tools }, reason: 'initial' });
    session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name, arguments: args }], source: { provider, model } }) }, { surfaceOp: 'append' });
    session.append('tool/call', { turn, step: 1, callId, name, arguments: args });
    session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: stage.output }], isError: false }) }, { surfaceOp: 'append' });
    session.append('step/end', { turn, step: 1 });
    session.append('step/start', { turn, step: 2 });
    session.append('assistant/message', { turn, step: 2, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: stage.conclusion }], source: { provider, model } }) }, { surfaceOp: 'append' });
    session.append('step/end', { turn, step: 2 });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  });
  session.append('turn/start', { turn: 6 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: finalUserRequest }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('turn/end', { turn: 6, reason: { kind: 'completed' } });
}

/** Ask for source facts without supplying their expected values. */
export const recallPrompt = `Read only the available conversation and return one JSON object with the following keys. Use null when a requested fact is unavailable. Do not infer missing facts, carry out the task, or use tools.
- ttl_hours: the final approved idempotency retention period in hours.
- idempotency_header: the exact request header name.
- retry_statuses: the array of HTTP status codes eligible for retry.
- max_attempts: the maximum total number of requests, including the first attempt.
- backoff_ms: the ordered array of waits between attempts in milliseconds.
- unique_key: the array of database columns that jointly identify an invoice.
- migration_file: the migration's repository-relative path.
- test_command: the exact most recently executed local test command in the recorded history.
- test_counts: an object with passed and skipped numeric counts from that run.
- next_step: the remaining regression test that still needs to be added.
- production_contact_allowed: whether this task permits contacting production, as a boolean.
- migration_apply_allowed: whether this task permits applying the migration, as a boolean.
Return JSON only; a proposal or skipped check must not be presented as completed work.`;

function parseRecall(text) {
  const source = String(text).trim();
  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          const result = JSON.parse(source.slice(start, index + 1));
          if (result && typeof result === 'object' && !Array.isArray(result)) return result;
        } catch (error) { /* Try the next complete object when surrounding prose contains braces. */ }
        break;
      }
    }
  }
  return {};
}

const numeric = value => typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : undefined;
const normalized = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
const sameNumbers = (value, expected, sorted = false) => Array.isArray(value) && value.length === expected.length && (sorted ? value.map(numeric).sort((a, b) => a - b) : value.map(numeric)).every((item, index) => item === expected[index]);

/** Score facts deterministically while returning each observed value for the report. */
export function scoreRecall(text) {
  const answer = parseRecall(text);
  const checks = [];
  const check = (name, passed, expected, actual) => checks.push({ name, passed: Boolean(passed), expected, actual: actual ?? null });
  check('final retention', numeric(answer.ttl_hours) === 48, 48, answer.ttl_hours);
  check('idempotency header', normalized(answer.idempotency_header) === 'idempotency-key', 'Idempotency-Key', answer.idempotency_header);
  check('retry statuses', sameNumbers(answer.retry_statuses, [429, 502, 503, 504], true), [429, 502, 503, 504], answer.retry_statuses);
  check('finite retry schedule', numeric(answer.max_attempts) === 3 && sameNumbers(answer.backoff_ms, [250, 500]), { max_attempts: 3, backoff_ms: [250, 500] }, { max_attempts: answer.max_attempts ?? null, backoff_ms: answer.backoff_ms ?? null });
  check('invoice uniqueness', Array.isArray(answer.unique_key) && answer.unique_key.length === 2 && [...answer.unique_key].sort().join('|') === 'external_invoice_id|tenant_id', ['tenant_id', 'external_invoice_id'], answer.unique_key);
  check('migration path', typeof answer.migration_file === 'string' && answer.migration_file.trim().replaceAll('\\', '/').replace(/^\.\//, '') === 'migrations/20260926_invoice_import.sql', 'migrations/20260926_invoice_import.sql', answer.migration_file);
  check('observed local verification', normalized(answer.test_command) === 'pnpm test -- invoice-import' && numeric(answer.test_counts?.passed) === 17 && numeric(answer.test_counts?.skipped) === 1, { command: 'pnpm test -- invoice-import', passed: 17, skipped: 1 }, { command: answer.test_command ?? null, counts: answer.test_counts ?? null });
  const next = normalized(answer.next_step);
  check('pending regression', /\btenant\b/.test(next) && /isolat|cross[- ]tenant/.test(next) && /regression|test/.test(next) && !/\b(already|completed|finished|done)\b/.test(next), 'Add a tenant isolation regression test', answer.next_step);
  check('production restriction', answer.production_contact_allowed === false, false, answer.production_contact_allowed);
  check('migration restriction', answer.migration_apply_allowed === false, false, answer.migration_apply_allowed);
  return { passed: checks.filter(item => item.passed).length, total: checks.length, checks };
}
