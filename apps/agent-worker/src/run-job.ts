import * as Y from 'yjs';
import {
  AGENT_ORIGIN,
  extractMentionPrompt,
  type AgentJobCompletionRequest,
  type AgentJobCompletionResponse,
  type AgentJobRequest,
  type AgentJobTransitionRequest,
  type AgentJobTransitionResponse,
} from '@co-pen/shared';
import {
  anchorAfterEachBlock,
  findMentionBlock,
  getFragment,
  insertParagraph,
  resolveBlockIndex,
  summarizeBlocks,
} from './doc-model';
import { env } from './env';
import { OutputSanitizationError, StreamSanitizer } from './guard/output-sanitizer';
import { requestJobCompletion, requestJobTransition } from './job-callback';
import { modelProvenance, planEdit, streamDraft } from './llm';
import type { AgentSession } from './session';
import { StreamWriter } from './stream-writer';

const SYNC_WAIT_TIMEOUT_MS = 3000;

export interface RunJobDependencies {
  transition(request: AgentJobTransitionRequest): Promise<AgentJobTransitionResponse>;
  complete(request: AgentJobCompletionRequest): Promise<AgentJobCompletionResponse>;
  plan: typeof planEdit;
  stream: typeof streamDraft;
  modelProvider: string;
  modelName: string;
}

const DEFAULT_DEPENDENCIES: RunJobDependencies = {
  transition: requestJobTransition,
  complete: requestJobCompletion,
  plan: planEdit,
  stream: streamDraft,
  modelProvider: modelProvenance.provider,
  modelName: modelProvenance.modelName,
};

function hasSeen(doc: Y.Doc, required: Map<number, number>): boolean {
  const current = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const [client, clock] of required) {
    if ((current.get(client) ?? 0) < clock) return false;
  }
  return true;
}

function waitForRequesterState(doc: Y.Doc, stateVector: string): Promise<void> {
  const required = Y.decodeStateVector(Buffer.from(stateVector, 'base64'));
  if (hasSeen(doc, required)) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      doc.off('update', onUpdate);
      resolve();
    };
    const onUpdate = () => {
      if (hasSeen(doc, required)) finish();
    };
    const timer = setTimeout(finish, SYNC_WAIT_TIMEOUT_MS);
    doc.on('update', onUpdate);
  });
}

async function transition(
  dependencies: RunJobDependencies,
  job: AgentJobRequest,
  expectedStatus: AgentJobTransitionRequest['expectedStatus'],
  nextStatus: AgentJobTransitionRequest['nextStatus'],
): Promise<boolean> {
  const response = await dependencies.transition({
    jobId: job.jobId,
    documentName: job.documentName,
    expectedStatus,
    nextStatus,
  });
  return response.transitioned && response.status === nextStatus;
}

async function reportFailure(
  dependencies: RunJobDependencies,
  job: AgentJobRequest,
  expectedStatus: 'planning' | 'writing',
  error: unknown,
): Promise<void> {
  const errorCode =
    error instanceof OutputSanitizationError ? error.code : 'worker_execution_failed';
  const errorMessage =
    errorCode === 'output_too_large'
      ? 'AI 출력이 허용된 길이를 초과했습니다.'
      : errorCode === 'output_sanitization_failed'
        ? 'AI 출력을 안전하게 정화하지 못했습니다.'
        : 'AI 작업 실행에 실패했습니다.';
  try {
    await dependencies.transition({
      jobId: job.jobId,
      documentName: job.documentName,
      expectedStatus,
      nextStatus: 'error',
      errorCode,
      errorMessage,
    });
  } catch {
    // The Sync Server recovery path will terminalize a stale active job.
  }
}

export async function runJob(
  session: AgentSession,
  job: AgentJobRequest,
  dependencies: RunJobDependencies = DEFAULT_DEPENDENCIES,
) {
  // The queued -> planning CAS is the exclusive execution claim. Duplicate dispatches stop here.
  if (!(await transition(dependencies, job, 'queued', 'planning'))) return;
  let ownedStatus: 'planning' | 'writing' = 'planning';

  try {
    const { doc } = session;
    const fragment = getFragment(doc);
    const prompt = extractMentionPrompt(job.mentionText);
    if (!prompt) throw new Error('invalid_mention');

    await waitForRequesterState(doc, job.stateVector);
    const blocks = summarizeBlocks(fragment);
    const anchors = anchorAfterEachBlock(fragment);
    const plan = await dependencies.plan({
      prompt,
      blocks,
      mentionIndex: findMentionBlock(blocks, job.mentionText),
    });

    // No Yjs mutation is allowed until the durable planning -> writing CAS succeeds.
    if (!(await transition(dependencies, job, 'planning', 'writing'))) return;
    ownedStatus = 'writing';

    const sanitizer = new StreamSanitizer();
    let sanitizedOutput = '';
    for await (const chunk of dependencies.stream({
      prompt,
      targetIndex: plan.targetIndex,
      blocks,
    })) {
      sanitizedOutput += sanitizer.push(chunk);
    }
    sanitizedOutput += sanitizer.end();
    if (!sanitizedOutput) throw new OutputSanitizationError('output_sanitization_failed');

    session.undoManager.stopCapturing();
    let target!: Y.XmlText;
    doc.transact(() => {
      target = insertParagraph(fragment, resolveBlockIndex(doc, anchors[plan.targetIndex]));
    }, AGENT_ORIGIN);
    const writer = new StreamWriter(
      doc,
      fragment,
      target,
      session.provider.awareness,
      env.flushIntervalMs,
      job.jobId,
    );
    writer.push(sanitizedOutput);
    writer.close();

    await dependencies.complete({
      jobId: job.jobId,
      documentName: job.documentName,
      sanitizedOutput,
      modelProvider: dependencies.modelProvider,
      modelName: dependencies.modelName,
    });
  } catch (error) {
    await reportFailure(dependencies, job, ownedStatus, error);
    throw error;
  }
}
