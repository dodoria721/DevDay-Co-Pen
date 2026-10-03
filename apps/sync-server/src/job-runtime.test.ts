import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as Y from 'yjs';
import { DOC_FIELD, type AgentJobStatus } from '@co-pen/shared';
import {
  JobAuditDatabaseError,
  type AgentJob,
  type AppendAuditEventInput,
  type AuditEvent,
  type CreateAgentJobInput,
  type CompleteAgentJobInput,
  type JobAuditStore,
  type TransitionAgentJobInput,
} from './job-audit-store';
import { DurableJobRuntime, JobRuntimeError, validateHumanMention } from './job-runtime';
import type { DocumentStore } from './persistence';

const DOCUMENT_NAME = '22222222-2222-4222-8222-222222222222';
const REQUESTER_ID = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY_KEY = '44444444-4444-4444-8444-444444444444';

function jobFrom(input: CreateAgentJobInput): AgentJob {
  return {
    ...input,
    status: 'queued',
    modelProvider: input.modelProvider ?? null,
    modelName: input.modelName ?? null,
    sanitizedOutput: null,
    outputHash: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

function auditFrom(input: AppendAuditEventInput, sequence: number): AuditEvent {
  return {
    id: `55555555-5555-4555-8555-${String(sequence).padStart(12, '0')}`,
    documentName: input.documentName,
    documentSequence: sequence,
    eventKey: input.eventKey,
    eventType: input.eventType,
    actorId: input.actorId,
    actorNameSnapshot: input.actorNameSnapshot,
    jobId: input.jobId ?? null,
    causationEventId: input.causationEventId ?? null,
    occurredAt: '2026-10-02T00:00:01.000Z',
    metadata: input.metadata ?? {},
    previousHash: sequence === 1 ? null : 'a'.repeat(64),
    eventHash: 'b'.repeat(64),
    hashVersion: 1,
  };
}

class MemoryJobAuditStore implements JobAuditStore {
  readonly jobs = new Map<string, AgentJob>();
  readonly idempotency = new Map<string, string>();
  readonly audits = new Map<string, AuditEvent>();
  failCreate = false;
  failRequestedAudit = false;

  async createAgentJob(input: CreateAgentJobInput) {
    if (this.failCreate) throw new JobAuditDatabaseError({ code: '08006' });
    const key = `${input.documentName}:${input.idempotencyKey}`;
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.jobs.get(existingId)!;
      if (
        existing.requestedByActorId !== input.requestedByActorId ||
        existing.promptHash !== input.promptHash ||
        existing.operationType !== input.operationType
      ) {
        throw new JobAuditDatabaseError({ code: '23505' });
      }
      return { job: existing, created: false };
    }
    const job = jobFrom(input);
    this.jobs.set(job.jobId, job);
    this.idempotency.set(key, job.jobId);
    return { job, created: true };
  }

  async getAgentJob(jobId: string) {
    return this.jobs.get(jobId) ?? null;
  }

  async getAuditEvent(documentName: string, eventKey: string) {
    return this.audits.get(`${documentName}:${eventKey}`) ?? null;
  }

  async listQueuedJobs() {
    return [...this.jobs.values()].filter((job) => job.status === 'queued');
  }

  async listStaleActiveJobs(staleBefore: string) {
    const cutoff = Date.parse(staleBefore);
    return [...this.jobs.values()].filter(
      (job) =>
        (job.status === 'planning' || job.status === 'writing') &&
        job.startedAt !== null &&
        Date.parse(job.startedAt) < cutoff,
    );
  }

  async listDocumentJobs(documentName: string) {
    return [...this.jobs.values()].filter((job) => job.documentName === documentName);
  }

  async transitionAgentJob(input: TransitionAgentJobInput) {
    const current = this.jobs.get(input.jobId);
    if (!current) throw new JobAuditDatabaseError({ code: 'P0002' });
    if (current.status !== input.expectedStatus) {
      throw new JobAuditDatabaseError({ code: 'P0001' });
    }
    const now = '2026-10-02T00:01:00.000Z';
    const next: AgentJob = {
      ...current,
      status: input.nextStatus,
      startedAt:
        input.nextStatus === 'planning' ? now : current.startedAt,
      finishedAt: input.nextStatus === 'done' || input.nextStatus === 'error' ? now : null,
      outputHash: input.nextStatus === 'done' ? (input.outputHash ?? null) : null,
      lastErrorCode: input.nextStatus === 'error' ? (input.errorCode ?? null) : null,
      lastErrorMessage: input.nextStatus === 'error' ? (input.errorMessage ?? null) : null,
    };
    this.jobs.set(next.jobId, next);
    return next;
  }

  async completeAgentJob(input: CompleteAgentJobInput) {
    const current = this.jobs.get(input.jobId);
    if (!current || current.documentName !== input.documentName) {
      throw new JobAuditDatabaseError({ code: 'P0002' });
    }
    if (current.status === 'done') {
      if (
        current.modelProvider !== input.modelProvider ||
        current.modelName !== input.modelName ||
        current.sanitizedOutput !== input.sanitizedOutput ||
        current.outputHash !== input.outputHash
      ) {
        throw new JobAuditDatabaseError({ code: '23505' });
      }
      return { job: current, completed: false };
    }
    if (current.status !== 'writing') throw new JobAuditDatabaseError({ code: 'P0001' });
    const job: AgentJob = {
      ...current,
      status: 'done',
      modelProvider: input.modelProvider,
      modelName: input.modelName,
      sanitizedOutput: input.sanitizedOutput,
      outputHash: input.outputHash,
      finishedAt: '2026-10-02T00:02:00.000Z',
    };
    this.jobs.set(job.jobId, job);
    await this.appendAuditEvent({
      documentName: job.documentName,
      eventKey: `job:${job.jobId}:completed`,
      eventType: 'ai_output_completed',
      actorId: job.agentActorId,
      actorNameSnapshot: 'Co-Pen AI',
      jobId: job.jobId,
      metadata: {
        operationType: job.operationType,
        outputHash: job.outputHash,
        modelProvider: job.modelProvider,
        modelName: job.modelName,
      },
    });
    return { job, completed: true };
  }

  async appendAuditEvent(input: AppendAuditEventInput) {
    if (this.failRequestedAudit && input.eventType === 'ai_job_requested') {
      throw new JobAuditDatabaseError({ code: '08006' });
    }
    const key = `${input.documentName}:${input.eventKey}`;
    const existing = this.audits.get(key);
    if (existing) return existing;
    const event = auditFrom(input, this.audits.size + 1);
    this.audits.set(key, event);
    return event;
  }
}

function documentState(mentionText = '@AI 결론을 작성해줘'): Uint8Array {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, mentionText);
  paragraph.insert(0, [text]);
  doc.getXmlFragment(DOC_FIELD).insert(0, [paragraph]);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

function documentStore(state = documentState()): DocumentStore {
  return {
    async load() {
      return state;
    },
    async save() {},
    async exists() {
      return true;
    },
    async createIfAbsent() {
      return false;
    },
  };
}

function mention(overrides: Partial<Parameters<DurableJobRuntime['acceptMention']>[0]> = {}) {
  const doc = new Y.Doc();
  const stateVector = Buffer.from(Y.encodeStateVector(doc)).toString('base64');
  doc.destroy();
  return {
    documentName: DOCUMENT_NAME,
    actorId: REQUESTER_ID,
    actorNameSnapshot: 'Requester',
    idempotencyKey: IDEMPOTENCY_KEY,
    mentionText: '@AI 결론을 작성해줘',
    stateVector,
    ...overrides,
  };
}

test('validates UUID idempotency keys and hashes only the server-extracted prompt', () => {
  const valid = validateHumanMention(mention());
  assert.match(valid.promptHash, /^[0-9a-f]{64}$/);
  assert.equal(valid.prompt, '결론을 작성해줘');
  assert.throws(
    () => validateHumanMention(mention({ idempotencyKey: 'eight123' })),
    (error: unknown) => error instanceof JobRuntimeError && error.code === 'invalid_agent_request',
  );
});

test('same idempotency key creates and dispatches exactly once', async () => {
  const store = new MemoryJobAuditStore();
  const dispatched: string[] = [];
  const runtime = new DurableJobRuntime({
    store,
    documentStore: documentStore(),
    dispatchJob: async (job) => void dispatched.push(job.jobId),
    broadcast() {},
  });
  const first = await runtime.acceptMention(mention());
  const repeated = await runtime.acceptMention(mention());
  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.job.jobId, first.job.jobId);
  assert.deepEqual(dispatched, [first.job.jobId]);
  assert.equal(store.audits.size, 1);
  const metadata = [...store.audits.values()][0]!.metadata;
  assert.deepEqual(Object.keys(metadata).sort(), ['operationType', 'promptHash']);
  assert.equal(JSON.stringify(metadata).includes('결론을 작성해줘'), false);
});

test('same key with a different logical prompt conflicts without dispatch', async () => {
  const store = new MemoryJobAuditStore();
  let dispatchCount = 0;
  const runtime = new DurableJobRuntime({
    store,
    documentStore: documentStore(),
    dispatchJob: async () => void (dispatchCount += 1),
    broadcast() {},
  });
  await runtime.acceptMention(mention());
  await assert.rejects(
    () => runtime.acceptMention(mention({ mentionText: '@AI 다른 요청' })),
    (error: unknown) => error instanceof JobRuntimeError && error.code === 'idempotency_conflict',
  );
  assert.equal(dispatchCount, 1);
  assert.equal(store.jobs.size, 1);
});

test('create and requested-audit failures never dispatch', async () => {
  for (const failure of ['create', 'audit'] as const) {
    const store = new MemoryJobAuditStore();
    store.failCreate = failure === 'create';
    store.failRequestedAudit = failure === 'audit';
    let dispatchCount = 0;
    const runtime = new DurableJobRuntime({
      store,
      documentStore: documentStore(),
      dispatchJob: async () => void (dispatchCount += 1),
      broadcast() {},
    });
    await assert.rejects(() => runtime.acceptMention(mention()), JobRuntimeError);
    assert.equal(dispatchCount, 0);
    if (failure === 'audit') {
      assert.equal([...store.jobs.values()][0]!.status, 'error');
    }
  }
});

test('dispatch failure terminalizes queued job and appends a failed event', async () => {
  const store = new MemoryJobAuditStore();
  const statuses: AgentJobStatus[] = [];
  const runtime = new DurableJobRuntime({
    store,
    documentStore: documentStore(),
    dispatchJob: async () => {
      throw new Error('worker unavailable');
    },
    broadcast: (_documentName, message) => statuses.push(message.status),
  });
  const result = await runtime.acceptMention(mention());
  assert.equal(result.job.status, 'error');
  assert.deepEqual(statuses, ['queued', 'error']);
  assert.ok([...store.audits.values()].some((event) => event.eventType === 'ai_job_failed'));
});

test('planning CAS allows one worker claim and rejects duplicate dispatch', async () => {
  const store = new MemoryJobAuditStore();
  const runtime = new DurableJobRuntime({
    store,
    documentStore: documentStore(),
    dispatchJob: async () => undefined,
    broadcast() {},
  });
  const accepted = await runtime.acceptMention(mention());
  const request = {
    jobId: accepted.job.jobId,
    documentName: DOCUMENT_NAME,
    expectedStatus: 'queued' as const,
    nextStatus: 'planning' as const,
  };
  const [first, duplicate] = await Promise.all([
    runtime.transitionFromWorker(request),
    runtime.transitionFromWorker(request),
  ]);
  assert.equal([first, duplicate].filter((result) => result.transitioned).length, 1);
  assert.equal(
    [...store.audits.values()].filter((event) => event.eventType === 'ai_job_started').length,
    1,
  );
});

test('completion hashes sanitized output and appends one minimal provenance event', async () => {
  const store = new MemoryJobAuditStore();
  const runtime = new DurableJobRuntime({
    store,
    documentStore: documentStore(),
    dispatchJob: async () => undefined,
    broadcast() {},
  });
  const accepted = await runtime.acceptMention(mention());
  await runtime.transitionFromWorker({
    jobId: accepted.job.jobId,
    documentName: DOCUMENT_NAME,
    expectedStatus: 'queued',
    nextStatus: 'planning',
  });
  await runtime.transitionFromWorker({
    jobId: accepted.job.jobId,
    documentName: DOCUMENT_NAME,
    expectedStatus: 'planning',
    nextStatus: 'writing',
  });
  const input = {
    jobId: accepted.job.jobId,
    documentName: DOCUMENT_NAME,
    sanitizedOutput: '최종 정화 결과',
    modelProvider: 'openai',
    modelName: 'gpt-test',
  };
  const first = await runtime.completeFromWorker(input);
  const repeated = await runtime.completeFromWorker(input);
  assert.equal(first.completed, true);
  assert.equal(repeated.completed, false);
  assert.equal(first.job.sanitizedOutput, input.sanitizedOutput);
  assert.equal(
    first.job.outputHash,
    createHash('sha256').update(input.sanitizedOutput, 'utf8').digest('hex'),
  );
  const completed = [...store.audits.values()].filter(
    (event) => event.eventType === 'ai_output_completed',
  );
  assert.equal(completed.length, 1);
  assert.deepEqual(Object.keys(completed[0]!.metadata).sort(), [
    'modelName',
    'modelProvider',
    'operationType',
    'outputHash',
  ]);
  assert.equal(JSON.stringify(completed[0]!.metadata).includes(input.sanitizedOutput), false);
  await assert.rejects(
    () => runtime.completeFromWorker({ ...input, modelName: 'different-model' }),
    (error: unknown) =>
      error instanceof JobRuntimeError && error.code === 'job_completion_conflict',
  );
});

test('startup recovery redispatches audited queued work from Yjs and errors stale active work', async () => {
  const store = new MemoryJobAuditStore();
  const dispatched: string[] = [];
  const runtime = new DurableJobRuntime({
    store,
    documentStore: documentStore(),
    dispatchJob: async (job) => void dispatched.push(job.jobId),
    broadcast() {},
    now: () => new Date('2026-10-02T01:00:00.000Z'),
  });
  const queued = await runtime.acceptMention(mention());
  dispatched.length = 0;

  const staleInput: CreateAgentJobInput = {
    jobId: '66666666-6666-4666-8666-666666666666',
    documentName: DOCUMENT_NAME,
    requestedByActorId: REQUESTER_ID,
    agentActorId: '00000000-0000-4000-8000-000000000001',
    operationType: 'insert_after',
    idempotencyKey: '77777777-7777-4777-8777-777777777777',
    promptHash: 'c'.repeat(64),
  };
  const stale = jobFrom(staleInput);
  stale.status = 'planning';
  stale.startedAt = '2026-10-02T00:00:00.000Z';
  store.jobs.set(stale.jobId, stale);

  const recovery = await runtime.recoverOnStartup(15 * 60 * 1000);
  assert.deepEqual(dispatched, [queued.job.jobId]);
  assert.equal(recovery.queuedDispatched, 1);
  assert.equal(recovery.staleFailed, 1);
  assert.equal(store.jobs.get(stale.jobId)?.status, 'error');
});
