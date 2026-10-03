import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { AGENT_SECRET_HEADER } from '@co-pen/shared';
import type { ActorStore } from './actors';
import { issueGuestToken } from './guest-token';
import {
  createJobRequestHandler,
  parseWorkerCompletion,
  parseWorkerTransition,
} from './job-http';
import type { AgentJob, JobAuditStore } from './job-audit-store';
import { JobRuntimeError } from './job-runtime';
import type { DocumentStore } from './persistence';

const DOCUMENT_NAME = '22222222-2222-4222-8222-222222222222';
const OTHER_DOCUMENT = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const GUEST_SECRET = 'guest-token-secret-that-is-at-least-32-bytes';
const AGENT_SECRET = 'agent-shared-secret';

const JOB: AgentJob = {
  jobId: JOB_ID,
  documentName: DOCUMENT_NAME,
  requestedByActorId: ACTOR_ID,
  agentActorId: '00000000-0000-4000-8000-000000000001',
  status: 'planning',
  operationType: 'insert_after',
  idempotencyKey: '55555555-5555-4555-8555-555555555555',
  promptHash: 'a'.repeat(64),
  modelProvider: null,
  modelName: null,
  sanitizedOutput: null,
  outputHash: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  startedAt: '2026-10-02T00:00:01.000Z',
  finishedAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
};

function documents(): DocumentStore {
  return {
    async load() {
      return null;
    },
    async save() {},
    async exists(name) {
      return name === DOCUMENT_NAME;
    },
    async createIfAbsent() {
      return false;
    },
  };
}

function actors(exists = true, failLookup = false): ActorStore {
  return {
    async createAnonymousActor() {
      return ACTOR_ID;
    },
    async anonymousActorExists() {
      if (failLookup) throw new Error('database_unavailable');
      return exists;
    },
  };
}

async function withServer(
  dependencies: Parameters<typeof createJobRequestHandler>[0],
  run: (origin: string) => Promise<void>,
) {
  const handler = createJobRequestHandler(dependencies);
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function dependencies(overrides: Partial<Parameters<typeof createJobRequestHandler>[0]> = {}) {
  const store = {
    async listDocumentJobs(documentName: string) {
      assert.equal(documentName, DOCUMENT_NAME);
      return [JOB];
    },
  } as JobAuditStore;
  return {
    runtime: {
      async transitionFromWorker() {
        return { job: { ...JOB, status: 'writing' as const }, transitioned: true };
      },
      async completeFromWorker() {
        return {
          job: { ...JOB, status: 'done' as const },
          completed: true,
        };
      },
    },
    store,
    documentStore: documents(),
    actorStore: actors(),
    guestTokenSecret: GUEST_SECRET,
    agentSharedSecret: AGENT_SECRET,
    ...overrides,
  };
}

test('worker transition payload accepts only bounded legal CAS transitions', () => {
  assert.ok(
    parseWorkerTransition({
      jobId: JOB_ID,
      documentName: DOCUMENT_NAME,
      expectedStatus: 'queued',
      nextStatus: 'planning',
    }),
  );
  assert.equal(
    parseWorkerTransition({
      jobId: JOB_ID,
      documentName: DOCUMENT_NAME,
      expectedStatus: 'queued',
      nextStatus: 'done',
    }),
    null,
  );
  assert.equal(
    parseWorkerTransition({
      jobId: JOB_ID,
      documentName: DOCUMENT_NAME,
      expectedStatus: 'planning',
      nextStatus: 'error',
      errorCode: 'INVALID CODE',
    }),
    null,
  );
});

test('worker completion accepts bounded provenance and never accepts a worker hash', () => {
  assert.ok(
    parseWorkerCompletion({
      jobId: JOB_ID,
      documentName: DOCUMENT_NAME,
      sanitizedOutput: 'safe output',
      modelProvider: 'openai',
      modelName: 'gpt-test',
    }),
  );
  assert.equal(
    parseWorkerCompletion({
      jobId: JOB_ID,
      documentName: DOCUMENT_NAME,
      sanitizedOutput: 'x'.repeat(4001),
      modelProvider: 'openai',
      modelName: 'gpt-test',
    }),
    null,
  );
  assert.equal(
    parseWorkerCompletion({
      jobId: JOB_ID,
      documentName: DOCUMENT_NAME,
      sanitizedOutput: 'safe output',
      modelProvider: 'openai',
      modelName: 'gpt-test',
      outputHash: 'a'.repeat(64),
    }),
    null,
  );
});

test('document status API authenticates first and returns only document-scoped jobs', async () => {
  const { token } = await issueGuestToken(ACTOR_ID, GUEST_SECRET);
  await withServer(dependencies(), async (origin) => {
    const missingAuth = await fetch(`${origin}/documents/${DOCUMENT_NAME}/agent-jobs`);
    assert.equal(missingAuth.status, 401);

    const unknown = await fetch(`${origin}/documents/${OTHER_DOCUMENT}/agent-jobs`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(unknown.status, 404);

    const response = await fetch(`${origin}/documents/${DOCUMENT_NAME}/agent-jobs`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { jobs: Array<Record<string, unknown>> };
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0]!.jobId, JOB_ID);
    assert.equal(body.jobs[0]!.status, 'planning');
    assert.equal('promptHash' in body.jobs[0]!, false);
  });
});

test('document status API separates stale identity from actor lookup outage', async () => {
  const { token } = await issueGuestToken(ACTOR_ID, GUEST_SECRET);
  for (const [actorStore, expectedStatus, expectedError] of [
    [actors(false), 401, 'invalid_guest_token'],
    [actors(true, true), 503, 'identity_validation_unavailable'],
  ] as const) {
    await withServer(dependencies({ actorStore }), async (origin) => {
      const response = await fetch(`${origin}/documents/${DOCUMENT_NAME}/agent-jobs`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, expectedStatus);
      assert.deepEqual(await response.json(), { error: expectedError });
    });
  }
});

test('worker callback requires the shared secret and hides cross-document job existence', async () => {
  let calls = 0;
  const runtime = {
    async transitionFromWorker(input: { documentName: string }) {
      calls += 1;
      if (input.documentName !== DOCUMENT_NAME) throw new JobRuntimeError('job_not_found', JOB_ID);
      return { job: { ...JOB, status: 'writing' as const }, transitioned: true };
    },
    async completeFromWorker() {
      return { job: { ...JOB, status: 'done' as const }, completed: true };
    },
  };
  await withServer(dependencies({ runtime }), async (origin) => {
    const body = JSON.stringify({
      jobId: JOB_ID,
      documentName: DOCUMENT_NAME,
      expectedStatus: 'planning',
      nextStatus: 'writing',
    });
    const unauthorized = await fetch(`${origin}/internal/agent-jobs/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(calls, 0);

    const accepted = await fetch(`${origin}/internal/agent-jobs/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AGENT_SECRET_HEADER]: AGENT_SECRET },
      body,
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { jobId: JOB_ID, status: 'writing', transitioned: true });

    const mismatch = await fetch(`${origin}/internal/agent-jobs/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AGENT_SECRET_HEADER]: AGENT_SECRET },
      body: JSON.stringify({
        jobId: JOB_ID,
        documentName: OTHER_DOCUMENT,
        expectedStatus: 'planning',
        nextStatus: 'writing',
      }),
    });
    assert.equal(mismatch.status, 404);
  });
});

test('completion callback requires agent secret and maps idempotency conflicts', async () => {
  let completions = 0;
  const runtime = {
    async transitionFromWorker() {
      return { job: { ...JOB, status: 'writing' as const }, transitioned: true };
    },
    async completeFromWorker(input: { modelName: string }) {
      completions += 1;
      if (input.modelName === 'different') {
        throw new JobRuntimeError('job_completion_conflict', JOB_ID);
      }
      return {
        job: {
          ...JOB,
          status: 'done' as const,
          modelProvider: 'openai',
          modelName: input.modelName,
          sanitizedOutput: 'safe output',
          outputHash: 'a'.repeat(64),
        },
        completed: completions === 1,
      };
    },
  };
  const body = (modelName = 'gpt-test') =>
    JSON.stringify({
      jobId: JOB_ID,
      documentName: DOCUMENT_NAME,
      sanitizedOutput: 'safe output',
      modelProvider: 'openai',
      modelName,
    });
  await withServer(dependencies({ runtime }), async (origin) => {
    const guestOnly = await fetch(`${origin}/internal/agent-jobs/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer guest' },
      body: body(),
    });
    assert.equal(guestOnly.status, 401);
    assert.equal(completions, 0);

    const first = await fetch(`${origin}/internal/agent-jobs/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AGENT_SECRET_HEADER]: AGENT_SECRET },
      body: body(),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { jobId: JOB_ID, status: 'done', completed: true });

    const duplicate = await fetch(`${origin}/internal/agent-jobs/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AGENT_SECRET_HEADER]: AGENT_SECRET },
      body: body(),
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { jobId: JOB_ID, status: 'done', completed: false });

    const conflict = await fetch(`${origin}/internal/agent-jobs/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AGENT_SECRET_HEADER]: AGENT_SECRET },
      body: body('different'),
    });
    assert.equal(conflict.status, 409);
  });
});
