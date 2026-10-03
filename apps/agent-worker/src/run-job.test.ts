import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import {
  DOC_FIELD,
  type AgentJobCompletionRequest,
  type AgentJobRequest,
  type AgentJobStatus,
  type AgentJobTransitionRequest,
  type AgentJobTransitionResponse,
} from '@co-pen/shared';
import { runJob, type RunJobDependencies } from './run-job';
import type { AgentSession } from './session';

const JOB: AgentJobRequest = {
  jobId: '11111111-1111-4111-8111-111111111111',
  documentName: '22222222-2222-4222-8222-222222222222',
  prompt: '결론을 써줘',
  requestedBy: 'Requester',
  mentionText: '@AI 결론을 써줘',
  stateVector: '',
};

function fixture() {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, JOB.mentionText);
  paragraph.insert(0, [text]);
  doc.getXmlFragment(DOC_FIELD).insert(0, [paragraph]);
  const session = {
    doc,
    provider: { awareness: null },
    undoManager: { stopCapturing() {} },
  } as unknown as AgentSession;
  return { doc, session, job: { ...JOB, stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64') } };
}

function lifecycle(overrides: Partial<RunJobDependencies> = {}) {
  let status: AgentJobStatus = 'queued';
  const calls: AgentJobTransitionRequest[] = [];
  const completions: AgentJobCompletionRequest[] = [];
  const dependencies: RunJobDependencies = {
    async transition(request): Promise<AgentJobTransitionResponse> {
      calls.push(request);
      if (status !== request.expectedStatus) {
        return { jobId: request.jobId, status, transitioned: false };
      }
      status = request.nextStatus;
      return { jobId: request.jobId, status, transitioned: true };
    },
    async complete(request) {
      completions.push(request);
      if (status !== 'writing') {
        return { jobId: request.jobId, status: 'done', completed: false };
      }
      status = 'done';
      return { jobId: request.jobId, status: 'done', completed: true };
    },
    async plan() {
      return { targetIndex: 0, action: 'insert_after' };
    },
    stream() {
      return (async function* () {
        yield '작성 결과';
      })();
    },
    modelProvider: 'mock',
    modelName: 'co-pen-mock-v1',
    ...overrides,
  };
  return { dependencies, calls, completions, status: () => status };
}

test('planning callback failure prevents planning and all Yjs mutation', async () => {
  const { doc, session, job } = fixture();
  const before = Y.encodeStateAsUpdate(doc);
  const { dependencies } = lifecycle({
    async transition() {
      throw new Error('callback unavailable');
    },
  });
  await assert.rejects(() => runJob(session, job, dependencies));
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  doc.destroy();
});

test('writing callback rejection prevents insertion and streaming', async () => {
  const { doc, session, job } = fixture();
  const before = Y.encodeStateAsUpdate(doc);
  let streamCalls = 0;
  const { dependencies } = lifecycle({
    async transition(request) {
      if (request.nextStatus === 'planning') {
        return { jobId: request.jobId, status: 'planning', transitioned: true };
      }
      return { jobId: request.jobId, status: 'error', transitioned: false };
    },
    stream() {
      streamCalls += 1;
      return (async function* () {})();
    },
  });
  await runJob(session, job, dependencies);
  assert.equal(streamCalls, 0);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  doc.destroy();
});

test('duplicate dispatch obtains one planning claim and mutates once', async () => {
  const { doc, session, job } = fixture();
  const control = lifecycle();
  await Promise.all([
    runJob(session, job, control.dependencies),
    runJob(session, job, control.dependencies),
  ]);
  assert.equal(
    control.calls.filter((call) => call.expectedStatus === 'queued' && call.nextStatus === 'planning').length,
    2,
  );
  assert.equal(doc.getXmlFragment(DOC_FIELD).length, 2);
  assert.equal(control.status(), 'done');
  doc.destroy();
});

test('the exact sanitized output mutates Yjs and is sent with authoritative model metadata', async () => {
  const { doc, session, job } = fixture();
  const control = lifecycle({
    stream() {
      return (async function* () {
        yield '<b>safe</b> https://example.com';
      })();
    },
    modelProvider: 'openai',
    modelName: 'gpt-test',
  });
  await runJob(session, job, control.dependencies);
  assert.equal(control.completions.length, 1);
  const completion = control.completions[0]!;
  assert.equal(completion.modelProvider, 'openai');
  assert.equal(completion.modelName, 'gpt-test');
  assert.equal(completion.sanitizedOutput.includes('<b>'), false);
  assert.equal(completion.sanitizedOutput.includes('https://'), false);
  const paragraph = doc.getXmlFragment(DOC_FIELD).toArray()[1] as Y.XmlElement;
  const inserted = paragraph.toArray()[0] as Y.XmlText;
  const insertedText = inserted
    .toDelta()
    .map((operation: { insert?: unknown }) =>
      typeof operation.insert === 'string' ? operation.insert : '',
    )
    .join('');
  assert.equal(insertedText, completion.sanitizedOutput);
  doc.destroy();
});

test('oversized output fails before any Yjs mutation', async () => {
  const { doc, session, job } = fixture();
  const before = Y.encodeStateAsUpdate(doc);
  const control = lifecycle({
    stream() {
      return (async function* () {
        yield 'x'.repeat(4001);
      })();
    },
  });
  await assert.rejects(() => runJob(session, job, control.dependencies), /output_too_large/);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert.equal(control.completions.length, 0);
  assert.equal(control.calls.at(-1)?.errorCode, 'output_too_large');
  doc.destroy();
});

test('stream or sanitizer failure cannot mutate the document', async () => {
  const { doc, session, job } = fixture();
  const before = Y.encodeStateAsUpdate(doc);
  const control = lifecycle({
    stream() {
      return (async function* () {
        yield 'not inserted';
        throw new Error('raw provider failure');
      })();
    },
  });
  await assert.rejects(() => runJob(session, job, control.dependencies));
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert.equal(control.completions.length, 0);
  assert.equal(JSON.stringify(control.calls).includes('raw provider failure'), false);
  doc.destroy();
});

test('invalid sanitizer input reports a bounded code without mutation', async () => {
  const { doc, session, job } = fixture();
  const before = Y.encodeStateAsUpdate(doc);
  const control = lifecycle({
    stream() {
      return (async function* () {
        yield null as unknown as string;
      })();
    },
  });
  await assert.rejects(() => runJob(session, job, control.dependencies), /output_sanitization_failed/);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert.equal(control.calls.at(-1)?.errorCode, 'output_sanitization_failed');
  doc.destroy();
});

test('completion callback failure never repeats the Yjs mutation', async () => {
  const { doc, session, job } = fixture();
  let completionCalls = 0;
  const control = lifecycle({
    async complete() {
      completionCalls += 1;
      throw new Error('callback unavailable');
    },
  });
  await assert.rejects(() => runJob(session, job, control.dependencies));
  assert.equal(doc.getXmlFragment(DOC_FIELD).length, 2);
  assert.equal(completionCalls, 1);
  doc.destroy();
});

test('execution failure reports a bounded durable error transition', async () => {
  const { doc, session, job } = fixture();
  const control = lifecycle({
    async plan() {
      throw new Error('raw provider details must not be forwarded');
    },
  });
  await assert.rejects(() => runJob(session, job, control.dependencies));
  const failure = control.calls.at(-1)!;
  assert.equal(failure.expectedStatus, 'planning');
  assert.equal(failure.nextStatus, 'error');
  assert.equal(failure.errorCode, 'worker_execution_failed');
  assert.equal(failure.errorMessage, 'AI 작업 실행에 실패했습니다.');
  assert.equal(JSON.stringify(failure).includes('raw provider details'), false);
  doc.destroy();
});
