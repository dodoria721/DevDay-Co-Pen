import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as Y from 'yjs';
import type { SyncServerEnvironment } from './config';
import {
  createJobAuditStore,
  JobAuditDatabaseError,
  type AgentJob,
  type AppendAuditEventInput,
  type CreateAgentJobInput,
  type JobAuditStore,
} from './job-audit-store';
import { createActorStore, DEFAULT_AGENT_ACTOR_ID } from './actors';
import { authenticateConnection, GuestAuthenticationError } from './authentication';
import { issueGuestToken } from './guest-token';
import { createGuestIdentity } from './identity-http';
import { DurableJobRuntime } from './job-runtime';
import { createDocumentStore } from './persistence';

const enabled = process.env.RUN_DB_INTEGRATION_TESTS === '1';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SANITIZED_OUTPUT = '통합 테스트 최종 출력';
const OUTPUT_HASH = createHash('sha256').update(SANITIZED_OUTPUT, 'utf8').digest('hex');

interface Fixture {
  documentName: string;
  requesterId: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function localEnvironment(): SyncServerEnvironment {
  return {
    appEnvironment: 'development',
    persistenceBackend: 'supabase',
    port: 1234,
    agentWorkerUrl: 'http://localhost:1235',
    jobStaleAfterMs: 900_000,
    agentSharedSecret: 'local-integration-agent-secret',
    guestTokenSecret: 'local-integration-guest-secret-at-least-32-bytes',
    supabaseUrl: required('LOCAL_SUPABASE_URL'),
    supabaseServiceRoleKey: required('LOCAL_SUPABASE_SERVICE_ROLE_KEY'),
    localDataDir: '.data-test',
  };
}

function serviceClient(): SupabaseClient {
  return createClient(
    required('LOCAL_SUPABASE_URL'),
    required('LOCAL_SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );
}

function anonymousClient(): SupabaseClient {
  return createClient(required('LOCAL_SUPABASE_URL'), required('LOCAL_SUPABASE_ANON_KEY'), {
    auth: { persistSession: false },
  });
}

async function fixture(client: SupabaseClient): Promise<Fixture> {
  const documentName = randomUUID();
  const { error: documentError } = await client
    .from('documents')
    .insert({ name: documentName, state: 'AAA=' });
  assert.equal(documentError, null);

  const { data: actor, error: actorError } = await client
    .from('actors')
    .insert({ kind: 'anonymous' })
    .select('id')
    .single();
  assert.equal(actorError, null);
  assert.equal(typeof actor?.id, 'string');
  return { documentName, requesterId: actor!.id as string };
}

function jobInput(fixtureValue: Fixture, overrides: Partial<CreateAgentJobInput> = {}): CreateAgentJobInput {
  return {
    jobId: randomUUID(),
    documentName: fixtureValue.documentName,
    requestedByActorId: fixtureValue.requesterId,
    agentActorId: DEFAULT_AGENT_ACTOR_ID,
    operationType: 'insert_after',
    idempotencyKey: randomUUID(),
    promptHash: SHA_A,
    ...overrides,
  };
}

async function createJob(
  store: JobAuditStore,
  fixtureValue: Fixture,
  overrides: Partial<CreateAgentJobInput> = {},
): Promise<AgentJob> {
  return (await store.createAgentJob(jobInput(fixtureValue, overrides))).job;
}

async function expectDatabaseCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof JobAuditDatabaseError && error.code === code,
  );
}

test('Local Supabase job/audit foundation', { skip: !enabled }, async (context) => {
  const client = serviceClient();
  const anon = anonymousClient();
  const store = createJobAuditStore(localEnvironment());

  await context.test('agent job constraints and idempotent creation', async () => {
    const firstFixture = await fixture(client);
    const input = jobInput(firstFixture, { idempotencyKey: 'same-document-key' });
    const first = await store.createAgentJob(input);
    const repeated = await store.createAgentJob(input);
    assert.equal(first.created, true);
    assert.equal(repeated.created, false);
    assert.equal(repeated.job.jobId, first.job.jobId);
    assert.equal((await store.getAgentJob(first.job.jobId))?.jobId, first.job.jobId);

    const concurrentInput = jobInput(firstFixture, { idempotencyKey: 'concurrent-job-key' });
    const concurrentCreates = await Promise.all(
      Array.from({ length: 10 }, () => store.createAgentJob(concurrentInput)),
    );
    assert.equal(concurrentCreates.filter((result) => result.created).length, 1);
    assert.equal(new Set(concurrentCreates.map((result) => result.job.jobId)).size, 1);

    const secondFixture = await fixture(client);
    const otherDocument = await store.createAgentJob(
      jobInput(secondFixture, { idempotencyKey: input.idempotencyKey }),
    );
    assert.equal(otherDocument.created, true);

    await expectDatabaseCode(
      () =>
        store.createAgentJob({
          ...input,
          jobId: randomUUID(),
          promptHash: SHA_B,
        }),
      '23505',
    );
    await expectDatabaseCode(
      () => store.createAgentJob(jobInput(firstFixture, { documentName: randomUUID() })),
      '23503',
    );
    await expectDatabaseCode(
      () => store.createAgentJob(jobInput(firstFixture, { requestedByActorId: randomUUID() })),
      '23503',
    );
    await expectDatabaseCode(
      () => store.createAgentJob(jobInput(firstFixture, { agentActorId: randomUUID() })),
      '23503',
    );
    await expectDatabaseCode(
      () =>
        store.createAgentJob(
          jobInput(firstFixture, { operationType: 'rewrite' as 'insert_after' }),
        ),
      '23514',
    );
    await expectDatabaseCode(
      () => store.createAgentJob(jobInput(firstFixture, { promptHash: 'not-a-hash' })),
      '23514',
    );
  });

  await context.test('allowed and rejected job transitions', async () => {
    const fixtureValue = await fixture(client);
    const happy = await createJob(store, fixtureValue);
    const planning = await store.transitionAgentJob({
      jobId: happy.jobId,
      expectedStatus: 'queued',
      nextStatus: 'planning',
    });
    assert.equal(planning.status, 'planning');
    assert.ok(planning.startedAt);
    assert.equal(planning.finishedAt, null);
    const writing = await store.transitionAgentJob({
      jobId: happy.jobId,
      expectedStatus: 'planning',
      nextStatus: 'writing',
    });
    assert.equal(writing.status, 'writing');
    assert.equal(writing.finishedAt, null);
    const done = await store.completeAgentJob({
      jobId: happy.jobId,
      documentName: fixtureValue.documentName,
      modelProvider: 'openai',
      modelName: 'integration-test-model',
      sanitizedOutput: SANITIZED_OUTPUT,
      outputHash: OUTPUT_HASH,
    });
    assert.equal(done.completed, true);
    assert.equal(done.job.status, 'done');
    assert.equal(done.job.sanitizedOutput, SANITIZED_OUTPUT);
    assert.equal(done.job.outputHash, OUTPUT_HASH);
    assert.ok(done.job.finishedAt);
    assert.ok(new Date(done.job.finishedAt!).getTime() >= new Date(done.job.startedAt!).getTime());
    const duplicateDone = await store.completeAgentJob({
      jobId: happy.jobId,
      documentName: fixtureValue.documentName,
      modelProvider: 'openai',
      modelName: 'integration-test-model',
      sanitizedOutput: SANITIZED_OUTPUT,
      outputHash: OUTPUT_HASH,
    });
    assert.equal(duplicateDone.completed, false);
    await expectDatabaseCode(
      () =>
        store.completeAgentJob({
          jobId: happy.jobId,
          documentName: fixtureValue.documentName,
          modelProvider: 'openai',
          modelName: 'different-model',
          sanitizedOutput: SANITIZED_OUTPUT,
          outputHash: OUTPUT_HASH,
        }),
      '23505',
    );
    await expectDatabaseCode(
      () =>
        store.transitionAgentJob({
          jobId: done.job.jobId,
          expectedStatus: 'done',
          nextStatus: 'error',
        }),
      '22023',
    );
    await expectDatabaseCode(
      () =>
        store.transitionAgentJob({
          jobId: done.job.jobId,
          expectedStatus: 'done',
          nextStatus: 'writing',
        }),
      '22023',
    );

    for (const start of ['queued', 'planning', 'writing'] as const) {
      const job = await createJob(store, fixtureValue);
      if (start === 'planning' || start === 'writing') {
        await store.transitionAgentJob({
          jobId: job.jobId,
          expectedStatus: 'queued',
          nextStatus: 'planning',
        });
      }
      if (start === 'writing') {
        await store.transitionAgentJob({
          jobId: job.jobId,
          expectedStatus: 'planning',
          nextStatus: 'writing',
        });
      }
      const failed = await store.transitionAgentJob({
        jobId: job.jobId,
        expectedStatus: start,
        nextStatus: 'error',
        errorCode: 'integration.failure',
        errorMessage: 'sanitized integration failure',
      });
      assert.equal(failed.status, 'error');
      assert.ok(failed.finishedAt);
      assert.equal(failed.lastErrorCode, 'integration.failure');
      await expectDatabaseCode(
        () =>
          store.transitionAgentJob({
            jobId: job.jobId,
            expectedStatus: 'error',
            nextStatus: 'queued',
          }),
        '22023',
      );
    }

    for (const nextStatus of ['writing', 'done'] as const) {
      const job = await createJob(store, fixtureValue);
      await expectDatabaseCode(
        () =>
          store.transitionAgentJob({
            jobId: job.jobId,
            expectedStatus: 'queued',
            nextStatus,
          }),
        '22023',
      );
    }

    const planningToDone = await createJob(store, fixtureValue);
    await store.transitionAgentJob({
      jobId: planningToDone.jobId,
      expectedStatus: 'queued',
      nextStatus: 'planning',
    });
    await expectDatabaseCode(
      () =>
        store.transitionAgentJob({
          jobId: planningToDone.jobId,
          expectedStatus: 'planning',
          nextStatus: 'done',
        }),
      '22023',
    );

    const hashMismatch = await createJob(store, fixtureValue);
    await store.transitionAgentJob({
      jobId: hashMismatch.jobId,
      expectedStatus: 'queued',
      nextStatus: 'planning',
    });
    await store.transitionAgentJob({
      jobId: hashMismatch.jobId,
      expectedStatus: 'planning',
      nextStatus: 'writing',
    });
    await expectDatabaseCode(
      () =>
        store.completeAgentJob({
          jobId: hashMismatch.jobId,
          documentName: fixtureValue.documentName,
          modelProvider: 'openai',
          modelName: 'integration-test-model',
          sanitizedOutput: SANITIZED_OUTPUT,
          outputHash: SHA_B,
        }),
      '22023',
    );

    const concurrent = await createJob(store, fixtureValue);
    const transitions = await Promise.allSettled([
      store.transitionAgentJob({
        jobId: concurrent.jobId,
        expectedStatus: 'queued',
        nextStatus: 'planning',
      }),
      store.transitionAgentJob({
        jobId: concurrent.jobId,
        expectedStatus: 'queued',
        nextStatus: 'planning',
      }),
    ]);
    assert.equal(transitions.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(transitions.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await store.getAgentJob(concurrent.jobId))?.status, 'planning');
  });

  await context.test('audit append validation, chaining, and idempotency', async () => {
    const fixtureValue = await fixture(client);
    const otherFixture = await fixture(client);
    const job = await createJob(store, fixtureValue);
    const otherJob = await createJob(store, otherFixture);
    const base: AppendAuditEventInput = {
      documentName: fixtureValue.documentName,
      eventKey: 'requested',
      eventType: 'ai_job_requested',
      actorId: fixtureValue.requesterId,
      actorNameSnapshot: 'Integration User',
      jobId: job.jobId,
      metadata: { channel: 'mention', nested: { stable: true } },
    };
    const first = await store.appendAuditEvent(base);
    assert.equal(first.documentSequence, 1);
    assert.equal(first.previousHash, null);
    assert.match(first.eventHash, /^[0-9a-f]{64}$/);

    const second = await store.appendAuditEvent({
      ...base,
      eventKey: 'started',
      eventType: 'ai_job_started',
      causationEventId: first.id,
    });
    assert.equal(second.documentSequence, 2);
    assert.equal(second.previousHash, first.eventHash);

    const repeated = await store.appendAuditEvent(base);
    assert.equal(repeated.id, first.id);
    assert.equal(repeated.eventHash, first.eventHash);
    const { count, error: countError } = await client
      .from('audit_events')
      .select('*', { count: 'exact', head: true })
      .eq('document_name', fixtureValue.documentName);
    assert.equal(countError, null);
    assert.equal(count, 2);

    await expectDatabaseCode(
      () => store.appendAuditEvent({ ...base, documentName: randomUUID(), eventKey: randomUUID() }),
      '23503',
    );
    await expectDatabaseCode(
      () => store.appendAuditEvent({ ...base, actorId: randomUUID(), eventKey: randomUUID() }),
      '23503',
    );
    await expectDatabaseCode(
      () => store.appendAuditEvent({ ...base, jobId: randomUUID(), eventKey: randomUUID() }),
      '23503',
    );
    await expectDatabaseCode(
      () => store.appendAuditEvent({ ...base, jobId: otherJob.jobId, eventKey: randomUUID() }),
      '23503',
    );
    await expectDatabaseCode(
      () =>
        store.appendAuditEvent({
          ...base,
          eventKey: randomUUID(),
          eventType: 'human_edit' as 'ai_job_requested',
        }),
      '22023',
    );
    await expectDatabaseCode(
      () =>
        store.appendAuditEvent({
          ...base,
          eventKey: randomUUID(),
          metadata: [] as unknown as Record<string, unknown>,
        }),
      '22023',
    );
  });

  await context.test('ten concurrent appends form one linear per-document chain', async () => {
    const fixtureValue = await fixture(client);
    const events = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.appendAuditEvent({
          documentName: fixtureValue.documentName,
          eventKey: `parallel-${index}`,
          eventType: 'ai_job_requested',
          actorId: fixtureValue.requesterId,
          actorNameSnapshot: 'Parallel User',
          metadata: { index },
        }),
      ),
    );
    assert.equal(new Set(events.map((event) => event.id)).size, 10);

    const { data: rows, error } = await client
      .from('audit_events')
      .select('id, document_sequence, previous_hash, event_hash')
      .eq('document_name', fixtureValue.documentName)
      .order('document_sequence');
    assert.equal(error, null);
    assert.equal(rows?.length, 10);
    assert.deepEqual(rows?.map((row) => Number(row.document_sequence)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let index = 0; index < 10; index += 1) {
      assert.equal(rows![index]!.previous_hash, index === 0 ? null : rows![index - 1]!.event_hash);
    }

    const { data: head, error: headError } = await client
      .from('document_audit_heads')
      .select('*')
      .eq('document_name', fixtureValue.documentName)
      .single();
    assert.equal(headError, null);
    assert.equal(Number(head?.last_sequence), 10);
    assert.equal(head?.last_event_hash, rows![9]!.event_hash);
    assert.equal(head?.last_event_id, rows![9]!.id);
  });

  await context.test('concurrent duplicate event keys append exactly once', async () => {
    const fixtureValue = await fixture(client);
    const input: AppendAuditEventInput = {
      documentName: fixtureValue.documentName,
      eventKey: 'duplicate-key',
      eventType: 'ai_job_requested',
      actorId: fixtureValue.requesterId,
      actorNameSnapshot: 'Retry User',
      metadata: { retry: true },
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.appendAuditEvent(input)),
    );
    assert.equal(new Set(results.map((event) => event.id)).size, 1);
    assert.equal(new Set(results.map((event) => event.eventHash)).size, 1);
    assert.ok(results.every((event) => event.documentSequence === 1));

    const { count, error } = await client
      .from('audit_events')
      .select('*', { count: 'exact', head: true })
      .eq('document_name', fixtureValue.documentName);
    assert.equal(error, null);
    assert.equal(count, 1);
    const { data: head, error: headError } = await client
      .from('document_audit_heads')
      .select('last_sequence')
      .eq('document_name', fixtureValue.documentName)
      .single();
    assert.equal(headError, null);
    assert.equal(Number(head?.last_sequence), 1);
  });

  await context.test('Data API privileges enforce RPC-only mutations', async () => {
    const fixtureValue = await fixture(client);
    const job = await createJob(store, fixtureValue);
    const event = await store.appendAuditEvent({
      documentName: fixtureValue.documentName,
      eventKey: 'privilege-event',
      eventType: 'ai_job_requested',
      actorId: fixtureValue.requesterId,
      actorNameSnapshot: 'Privilege User',
      jobId: job.jobId,
    });

    const directInsert = await client.from('audit_events').insert({
      id: randomUUID(),
      document_name: fixtureValue.documentName,
      document_sequence: 2,
      event_key: 'direct-insert',
      event_type: 'ai_job_requested',
      actor_id: fixtureValue.requesterId,
      actor_name_snapshot: 'Privilege User',
      occurred_at: new Date().toISOString(),
      metadata: {},
      previous_hash: event.eventHash,
      event_hash: SHA_A,
      hash_version: 1,
    });
    assert.equal(directInsert.error?.code, '42501');

    const directUpdate = await client
      .from('audit_events')
      .update({ actor_name_snapshot: 'tampered' })
      .eq('id', event.id);
    assert.equal(directUpdate.error?.code, '42501');

    const directDelete = await client.from('audit_events').delete().eq('id', event.id);
    assert.equal(directDelete.error?.code, '42501');

    const directHeadUpdate = await client
      .from('document_audit_heads')
      .update({ last_sequence: 999 })
      .eq('document_name', fixtureValue.documentName);
    assert.equal(directHeadUpdate.error?.code, '42501');

    const anonymousRead = await anon.from('agent_jobs').select('job_id').limit(1);
    assert.equal(anonymousRead.error?.code, '42501');
    const anonymousRpc = await anon.rpc('transition_agent_job', {
      p_job_id: job.jobId,
      p_expected_status: 'queued',
      p_next_status: 'planning',
    });
    assert.equal(anonymousRpc.error?.code, '42501');

    const transitioned = await store.transitionAgentJob({
      jobId: job.jobId,
      expectedStatus: 'queued',
      nextStatus: 'planning',
    });
    assert.equal(transitioned.status, 'planning');
  });

  await context.test('durable runtime uses the RPC boundary for acceptance and lifecycle', async () => {
    const fixtureValue = await fixture(client);
    const dispatched: string[] = [];
    const broadcastStatuses: string[] = [];
    const runtime = new DurableJobRuntime({
      store,
      documentStore: createDocumentStore(localEnvironment()),
      dispatchJob: async (job) => void dispatched.push(job.jobId),
      broadcast: (_documentName, message) => void broadcastStatuses.push(message.status),
    });
    const doc = new Y.Doc();
    const stateVector = Buffer.from(Y.encodeStateVector(doc)).toString('base64');
    doc.destroy();
    const idempotencyKey = randomUUID();
    const request = {
      documentName: fixtureValue.documentName,
      actorId: fixtureValue.requesterId,
      actorNameSnapshot: 'Integration Requester',
      idempotencyKey,
      mentionText: '@AI 통합 테스트 결론을 작성해줘',
      stateVector,
    };
    const accepted = await runtime.acceptMention(request);
    const repeated = await runtime.acceptMention(request);
    assert.equal(accepted.created, true);
    assert.equal(repeated.created, false);
    assert.equal(repeated.job.jobId, accepted.job.jobId);
    assert.deepEqual(dispatched, [accepted.job.jobId]);
    assert.ok((await store.listQueuedJobs()).some((job) => job.jobId === accepted.job.jobId));
    assert.equal(
      (await store.getAuditEvent(
        fixtureValue.documentName,
        `job:${accepted.job.jobId}:requested`,
      ))?.jobId,
      accepted.job.jobId,
    );

    const planning = await runtime.transitionFromWorker({
      jobId: accepted.job.jobId,
      documentName: fixtureValue.documentName,
      expectedStatus: 'queued',
      nextStatus: 'planning',
    });
    assert.equal(planning.transitioned, true);
    assert.ok(
      (await store.listStaleActiveJobs('2100-01-01T00:00:00.000Z')).some(
        (job) => job.jobId === accepted.job.jobId,
      ),
    );
    const duplicateClaim = await runtime.transitionFromWorker({
      jobId: accepted.job.jobId,
      documentName: fixtureValue.documentName,
      expectedStatus: 'queued',
      nextStatus: 'planning',
    });
    assert.equal(duplicateClaim.transitioned, false);
    await runtime.transitionFromWorker({
      jobId: accepted.job.jobId,
      documentName: fixtureValue.documentName,
      expectedStatus: 'planning',
      nextStatus: 'writing',
    });
    const completionInput = {
      jobId: accepted.job.jobId,
      documentName: fixtureValue.documentName,
      sanitizedOutput: SANITIZED_OUTPUT,
      modelProvider: 'openai',
      modelName: 'integration-test-model',
    };
    const completion = await runtime.completeFromWorker(completionInput);
    const duplicateCompletion = await runtime.completeFromWorker(completionInput);
    assert.equal(completion.completed, true);
    assert.equal(duplicateCompletion.completed, false);
    assert.deepEqual(broadcastStatuses, ['queued', 'planning', 'writing', 'done']);

    const documentJobs = await store.listDocumentJobs(fixtureValue.documentName);
    assert.equal(documentJobs[0]?.status, 'done');
    assert.equal(documentJobs[0]?.sanitizedOutput, SANITIZED_OUTPUT);
    assert.equal(documentJobs[0]?.outputHash, OUTPUT_HASH);
    assert.equal(documentJobs[0]?.modelProvider, 'openai');
    assert.equal(documentJobs[0]?.modelName, 'integration-test-model');
    const { data: events, error } = await client
      .from('audit_events')
      .select('event_type, metadata')
      .eq('job_id', accepted.job.jobId)
      .order('document_sequence');
    assert.equal(error, null);
    assert.deepEqual(events?.map((event) => event.event_type), [
      'ai_job_requested',
      'ai_job_started',
      'ai_output_completed',
    ]);
    assert.deepEqual(events?.at(-1)?.metadata, {
      modelName: 'integration-test-model',
      modelProvider: 'openai',
      operationType: 'insert_after',
      outputHash: OUTPUT_HASH,
    });
    assert.equal(JSON.stringify(events).includes('통합 테스트 결론'), false);
    assert.equal(JSON.stringify(events).includes(SANITIZED_OUTPUT), false);
  });

  await context.test('stale guest identity is reissued before durable job creation', async () => {
    const environment = localEnvironment();
    const actors = createActorStore(environment);
    const staleActorId = randomUUID();
    const staleToken = (await issueGuestToken(staleActorId, environment.guestTokenSecret)).token;
    await assert.rejects(
      () => authenticateConnection(staleToken, environment, actors),
      (error: unknown) =>
        error instanceof GuestAuthenticationError && error.code === 'invalid_guest_token',
    );

    const credential = await createGuestIdentity(actors, environment.guestTokenSecret);
    const contextValue = await authenticateConnection(credential.token, environment, actors);
    assert.equal(contextValue.actorId, credential.actorId);

    const documentName = randomUUID();
    const { error: documentError } = await client
      .from('documents')
      .insert({ name: documentName, state: 'AAA=' });
    assert.equal(documentError, null);
    const dispatched: string[] = [];
    const runtime = new DurableJobRuntime({
      store,
      documentStore: createDocumentStore(environment),
      dispatchJob: async (job) => void dispatched.push(job.jobId),
      broadcast() {},
    });
    const doc = new Y.Doc();
    const stateVector = Buffer.from(Y.encodeStateVector(doc)).toString('base64');
    doc.destroy();
    const accepted = await runtime.acceptMention({
      documentName,
      actorId: contextValue.actorId,
      actorNameSnapshot: 'Reissued Guest',
      idempotencyKey: randomUUID(),
      mentionText: '@AI 새 인증으로 작업을 만들어줘',
      stateVector,
    });
    assert.equal(accepted.created, true);
    assert.equal(accepted.job.requestedByActorId, credential.actorId);
    assert.deepEqual(dispatched, [accepted.job.jobId]);
  });
});
