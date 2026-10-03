import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncServerEnvironment } from './config';
import {
  createJobAuditStore,
  JobAuditDatabaseError,
  type JobAuditDataSource,
} from './job-audit-store';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_NAME = '22222222-2222-4222-8222-222222222222';
const REQUESTER_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '00000000-0000-4000-8000-000000000001';

const JOB_ROW = {
  job_id: JOB_ID,
  document_name: DOCUMENT_NAME,
  requested_by_actor_id: REQUESTER_ID,
  agent_actor_id: AGENT_ID,
  status: 'queued',
  operation_type: 'insert_after',
  idempotency_key: 'request-1',
  prompt_hash: 'a'.repeat(64),
  model_provider: null,
  model_name: null,
  sanitized_output: null,
  output_hash: null,
  created_at: '2026-10-02T00:00:00.000Z',
  started_at: null,
  finished_at: null,
  last_error_code: null,
  last_error_message: null,
};

function environment(backend: 'supabase' | 'file' = 'supabase'): SyncServerEnvironment {
  return {
    appEnvironment: 'development',
    persistenceBackend: backend,
    port: 1234,
    agentWorkerUrl: 'http://localhost:1235',
    jobStaleAfterMs: 900_000,
    agentSharedSecret: 'agent-secret',
    guestTokenSecret: 'guest-token-secret-that-is-at-least-32-bytes',
    supabaseUrl: backend === 'supabase' ? 'https://example.supabase.co' : undefined,
    supabaseServiceRoleKey: backend === 'supabase' ? 'service-role-key' : undefined,
    localDataDir: '.data-test',
  };
}

test('job/audit store is explicitly unavailable for file persistence', () => {
  assert.throws(() => createJobAuditStore(environment('file')), /job_audit_requires_supabase/);
});

test('create, get, transition, and append wrappers map the database contract', async () => {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const source: JobAuditDataSource = {
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      if (name === 'create_agent_job') {
        return { data: { created: true, job: JOB_ROW }, error: null };
      }
      if (name === 'transition_agent_job') {
        return {
          data: {
            ...JOB_ROW,
            status: 'planning',
            started_at: '2026-10-02T00:00:01.000Z',
          },
          error: null,
        };
      }
      if (name === 'complete_agent_job') {
        return {
          data: {
            completed: true,
            job: {
              ...JOB_ROW,
              status: 'done',
              model_provider: 'openai',
              model_name: 'gpt-test',
              sanitized_output: 'safe output',
              output_hash: 'c'.repeat(64),
              started_at: '2026-10-02T00:00:01.000Z',
              finished_at: '2026-10-02T00:00:02.000Z',
            },
          },
          error: null,
        };
      }
      return {
        data: {
          id: '44444444-4444-4444-8444-444444444444',
          document_name: DOCUMENT_NAME,
          document_sequence: 1,
          event_key: 'event-1',
          event_type: 'ai_job_requested',
          actor_id: REQUESTER_ID,
          actor_name_snapshot: 'Requester',
          job_id: JOB_ID,
          causation_event_id: null,
          occurred_at: '2026-10-02T00:00:02.000Z',
          metadata: { source: 'test' },
          previous_hash: null,
          event_hash: 'b'.repeat(64),
          hash_version: 1,
        },
        error: null,
      };
    },
    async getAgentJob(jobId) {
      assert.equal(jobId, JOB_ID);
      return { data: JOB_ROW, error: null };
    },
    async getAuditEvent() {
      return { data: null, error: null };
    },
    async listQueuedJobs() {
      return { data: [JOB_ROW], error: null };
    },
    async listStaleActiveJobs() {
      return { data: [], error: null };
    },
    async listDocumentJobs() {
      return { data: [JOB_ROW], error: null };
    },
  };
  const store = createJobAuditStore(environment(), source);

  const created = await store.createAgentJob({
    jobId: JOB_ID,
    documentName: DOCUMENT_NAME,
    requestedByActorId: REQUESTER_ID,
    agentActorId: AGENT_ID,
    operationType: 'insert_after',
    idempotencyKey: 'request-1',
    promptHash: 'a'.repeat(64),
  });
  assert.equal(created.created, true);
  assert.equal(created.job.jobId, JOB_ID);
  assert.equal((await store.getAgentJob(JOB_ID))?.documentName, DOCUMENT_NAME);

  const transitioned = await store.transitionAgentJob({
    jobId: JOB_ID,
    expectedStatus: 'queued',
    nextStatus: 'planning',
  });
  assert.equal(transitioned.status, 'planning');
  assert.ok(transitioned.startedAt);

  const completed = await store.completeAgentJob({
    jobId: JOB_ID,
    documentName: DOCUMENT_NAME,
    modelProvider: 'openai',
    modelName: 'gpt-test',
    sanitizedOutput: 'safe output',
    outputHash: 'c'.repeat(64),
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.job.sanitizedOutput, 'safe output');

  const event = await store.appendAuditEvent({
    documentName: DOCUMENT_NAME,
    eventKey: 'event-1',
    eventType: 'ai_job_requested',
    actorId: REQUESTER_ID,
    actorNameSnapshot: 'Requester',
    jobId: JOB_ID,
    metadata: { source: 'test' },
  });
  assert.equal(event.documentSequence, 1);
  assert.equal(event.previousHash, null);
  assert.equal(event.eventHash, 'b'.repeat(64));
  assert.deepEqual(calls.map((call) => call.name), [
    'create_agent_job',
    'transition_agent_job',
    'complete_agent_job',
    'append_audit_event',
  ]);
});

test('database errors retain only the SQLSTATE for programmatic handling', async () => {
  const source: JobAuditDataSource = {
    async rpc() {
      return { data: null, error: { code: '23503', message: 'sensitive details' } };
    },
    async getAgentJob() {
      return { data: null, error: null };
    },
    async getAuditEvent() {
      return { data: null, error: null };
    },
    async listQueuedJobs() {
      return { data: null, error: null };
    },
    async listStaleActiveJobs() {
      return { data: null, error: null };
    },
    async listDocumentJobs() {
      return { data: null, error: null };
    },
  };
  const store = createJobAuditStore(environment(), source);

  await assert.rejects(
    () =>
      store.createAgentJob({
        jobId: JOB_ID,
        documentName: DOCUMENT_NAME,
        requestedByActorId: REQUESTER_ID,
        agentActorId: AGENT_ID,
        operationType: 'insert_after',
        idempotencyKey: 'request-1',
        promptHash: 'a'.repeat(64),
      }),
    (error: unknown) =>
      error instanceof JobAuditDatabaseError &&
      error.code === '23503' &&
      error.message === 'job_audit_database_error',
  );
});
