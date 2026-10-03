import { createHash, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import {
  AGENT_USER,
  DOC_FIELD,
  extractMentionPrompt,
  type AgentJobCompletionRequest,
  type AgentJobRequest,
  type AgentJobStatus,
  type AgentJobTransitionRequest,
  type AgentStatelessMessage,
} from '@co-pen/shared';
import { DEFAULT_AGENT_ACTOR_ID } from './actors';
import {
  JobAuditDatabaseError,
  type AgentJob,
  type JobAuditStore,
} from './job-audit-store';
import type { DocumentStore } from './persistence';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_STATE_VECTOR_BYTES = 16 * 1024;
const MAX_ACTOR_NAME_LENGTH = 200;
export const MAX_SANITIZED_OUTPUT_CHARS = 4000;
const RECOVERY_BATCH_SIZE = 100;
const MODEL_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/;

export class JobRuntimeError extends Error {
  constructor(
    readonly code:
      | 'invalid_agent_request'
      | 'idempotency_conflict'
      | 'job_acceptance_failed'
      | 'invalid_agent_completion'
      | 'job_completion_conflict'
      | 'job_completion_failed'
      | 'job_not_found'
      | 'job_transition_failed',
    readonly jobId = 'request',
    readonly idempotencyKey?: string,
  ) {
    super(code);
  }
}

export interface HumanMentionInput {
  documentName: string;
  actorId: string;
  actorNameSnapshot: unknown;
  idempotencyKey: unknown;
  mentionText: unknown;
  stateVector: unknown;
}

export interface JobRuntimeDependencies {
  store: JobAuditStore;
  documentStore: DocumentStore;
  dispatchJob(job: AgentJobRequest): Promise<void>;
  broadcast(documentName: string, message: AgentStatelessMessage): void;
  now?: () => Date;
}

export interface AcceptMentionResult {
  job: AgentJob;
  created: boolean;
}

export interface TransitionResult {
  job: AgentJob;
  transitioned: boolean;
}

export interface CompletionResult {
  job: AgentJob;
  completed: boolean;
}

export interface RecoveryResult {
  queuedDispatched: number;
  queuedFailed: number;
  staleFailed: number;
}

interface ValidatedMention {
  idempotencyKey: string;
  actorNameSnapshot: string;
  mentionText: string;
  stateVector: string;
  prompt: string;
  promptHash: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateStateVector(value: unknown): value is string {
  if (typeof value !== 'string' || !value || !BASE64_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_STATE_VECTOR_BYTES) return false;
  try {
    Y.decodeStateVector(bytes);
    return true;
  } catch {
    return false;
  }
}

export function validateHumanMention(input: HumanMentionInput): ValidatedMention {
  if (typeof input.idempotencyKey !== 'string' || !UUID_V4_PATTERN.test(input.idempotencyKey)) {
    throw new JobRuntimeError('invalid_agent_request');
  }
  if (typeof input.mentionText !== 'string' || !validateStateVector(input.stateVector)) {
    throw new JobRuntimeError('invalid_agent_request', 'request', input.idempotencyKey);
  }
  const mentionText = input.mentionText.trim();
  const prompt = extractMentionPrompt(mentionText);
  if (!prompt) {
    throw new JobRuntimeError('invalid_agent_request', 'request', input.idempotencyKey);
  }
  const requestedName =
    typeof input.actorNameSnapshot === 'string' ? input.actorNameSnapshot.trim() : '';
  const actorNameSnapshot = (requestedName || 'Guest').slice(0, MAX_ACTOR_NAME_LENGTH);
  return {
    idempotencyKey: input.idempotencyKey,
    actorNameSnapshot,
    mentionText,
    stateVector: input.stateVector,
    prompt,
    promptHash: sha256(prompt),
  };
}

export function jobStatusMessage(job: AgentJob): AgentStatelessMessage {
  return {
    type: 'agent:status',
    jobId: job.jobId,
    status: job.status,
    idempotencyKey: job.idempotencyKey,
    ...(job.status === 'error' && job.lastErrorMessage
      ? { message: job.lastErrorMessage }
      : {}),
  };
}

function plainText(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (node instanceof Y.XmlText) {
    return node
      .toDelta()
      .map((operation: { insert?: unknown }) =>
        typeof operation.insert === 'string' ? operation.insert : '',
      )
      .join('');
  }
  if (node instanceof Y.XmlElement) {
    const children = node.toArray();
    const separator = children.some((child) => child instanceof Y.XmlElement) ? '\n' : '';
    return children.map(plainText).join(separator);
  }
  return '';
}

function recoverRequestFromState(
  job: AgentJob,
  state: Uint8Array,
  requestedBy: string,
): AgentJobRequest | null {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, state);
    const candidates = document
      .getXmlFragment(DOC_FIELD)
      .toArray()
      .map(plainText)
      .map((text) => ({ text: text.trim(), prompt: extractMentionPrompt(text) }))
      .filter(
        (candidate): candidate is { text: string; prompt: string } =>
          candidate.prompt !== null && sha256(candidate.prompt) === job.promptHash,
      );
    // A hash alone is not a durable position anchor. Refuse ambiguous recovery.
    if (candidates.length !== 1) return null;
    return {
      jobId: job.jobId,
      documentName: job.documentName,
      prompt: candidates[0]!.prompt,
      requestedBy,
      mentionText: candidates[0]!.text,
      stateVector: Buffer.from(Y.encodeStateVector(document)).toString('base64'),
    };
  } catch {
    return null;
  } finally {
    document.destroy();
  }
}

export class DurableJobRuntime {
  private readonly now: () => Date;

  constructor(private readonly dependencies: JobRuntimeDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async acceptMention(input: HumanMentionInput): Promise<AcceptMentionResult> {
    const request = validateHumanMention(input);
    let result: Awaited<ReturnType<JobAuditStore['createAgentJob']>>;
    try {
      result = await this.dependencies.store.createAgentJob({
        jobId: randomUUID(),
        documentName: input.documentName,
        requestedByActorId: input.actorId,
        agentActorId: DEFAULT_AGENT_ACTOR_ID,
        operationType: 'insert_after',
        idempotencyKey: request.idempotencyKey,
        promptHash: request.promptHash,
      });
    } catch (error) {
      if (error instanceof JobAuditDatabaseError && error.code === '23505') {
        throw new JobRuntimeError(
          'idempotency_conflict',
          'request',
          request.idempotencyKey,
        );
      }
      throw new JobRuntimeError(
        'job_acceptance_failed',
        'request',
        request.idempotencyKey,
      );
    }

    if (!result.created) return result;

    try {
      await this.dependencies.store.appendAuditEvent({
        documentName: result.job.documentName,
        eventKey: `job:${result.job.jobId}:requested`,
        eventType: 'ai_job_requested',
        actorId: input.actorId,
        actorNameSnapshot: request.actorNameSnapshot,
        jobId: result.job.jobId,
        metadata: {
          operationType: result.job.operationType,
          promptHash: result.job.promptHash,
        },
      });
    } catch {
      await this.failJob(
        result.job,
        'queued',
        'requested_audit_failed',
        'AI 요청을 안전하게 기록하지 못했습니다.',
      );
      throw new JobRuntimeError(
        'job_acceptance_failed',
        result.job.jobId,
        result.job.idempotencyKey,
      );
    }

    this.dependencies.broadcast(result.job.documentName, jobStatusMessage(result.job));
    try {
      await this.dependencies.dispatchJob({
        jobId: result.job.jobId,
        documentName: result.job.documentName,
        prompt: request.prompt,
        requestedBy: request.actorNameSnapshot,
        mentionText: request.mentionText,
        stateVector: request.stateVector,
      });
      return result;
    } catch {
      const failed = await this.failJob(
        result.job,
        'queued',
        'dispatch_failed',
        'AI 작업을 시작하지 못했습니다.',
      );
      return { created: true, job: failed };
    }
  }

  async transitionFromWorker(input: AgentJobTransitionRequest): Promise<TransitionResult> {
    const job = await this.dependencies.store.getAgentJob(input.jobId);
    if (!job || job.documentName !== input.documentName) {
      throw new JobRuntimeError('job_not_found', input.jobId);
    }
    if (job.status !== input.expectedStatus) return { job, transitioned: false };

    let transitioned: AgentJob;
    try {
      transitioned = await this.dependencies.store.transitionAgentJob({
        jobId: job.jobId,
        expectedStatus: input.expectedStatus,
        nextStatus: input.nextStatus,
        ...(input.nextStatus === 'error'
          ? {
              // Never persist provider/runtime details supplied over the worker channel.
              errorCode: 'worker_execution_failed',
              errorMessage: 'AI 작업 실행에 실패했습니다.',
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof JobAuditDatabaseError && error.code === 'P0001') {
        const current = await this.dependencies.store.getAgentJob(input.jobId);
        if (current) return { job: current, transitioned: false };
      }
      throw new JobRuntimeError('job_transition_failed', input.jobId);
    }

    if (transitioned.status === 'planning') {
      try {
        await this.dependencies.store.appendAuditEvent({
          documentName: transitioned.documentName,
          eventKey: `job:${transitioned.jobId}:planning`,
          eventType: 'ai_job_started',
          actorId: DEFAULT_AGENT_ACTOR_ID,
          actorNameSnapshot: AGENT_USER.name,
          jobId: transitioned.jobId,
          metadata: {
            operationType: transitioned.operationType,
            promptHash: transitioned.promptHash,
          },
        });
      } catch {
        await this.failJob(
          transitioned,
          'planning',
          'planning_audit_failed',
          'AI 작업 시작을 안전하게 기록하지 못했습니다.',
        );
        throw new JobRuntimeError('job_transition_failed', input.jobId);
      }
    } else if (transitioned.status === 'error') {
      try {
        await this.appendFailedAudit(transitioned);
      } catch {
        // The durable terminal status is still authoritative. The HTTP caller gets a safe failure.
        this.dependencies.broadcast(transitioned.documentName, jobStatusMessage(transitioned));
        throw new JobRuntimeError('job_transition_failed', input.jobId);
      }
    }

    this.dependencies.broadcast(transitioned.documentName, jobStatusMessage(transitioned));
    return { job: transitioned, transitioned: true };
  }

  async completeFromWorker(input: AgentJobCompletionRequest): Promise<CompletionResult> {
    if (
      typeof input.sanitizedOutput !== 'string' ||
      input.sanitizedOutput.length < 1 ||
      input.sanitizedOutput.length > MAX_SANITIZED_OUTPUT_CHARS ||
      typeof input.modelProvider !== 'string' ||
      input.modelProvider.length < 1 ||
      input.modelProvider.length > 100 ||
      !MODEL_PROVIDER_PATTERN.test(input.modelProvider) ||
      typeof input.modelName !== 'string' ||
      input.modelName.length < 1 ||
      input.modelName.length > 200 ||
      input.modelName.trim() !== input.modelName
    ) {
      throw new JobRuntimeError('invalid_agent_completion', input.jobId);
    }

    let result: CompletionResult;
    try {
      result = await this.dependencies.store.completeAgentJob({
        jobId: input.jobId,
        documentName: input.documentName,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        sanitizedOutput: input.sanitizedOutput,
        outputHash: sha256(input.sanitizedOutput),
      });
    } catch (error) {
      if (error instanceof JobAuditDatabaseError) {
        if (error.code === 'P0002') {
          throw new JobRuntimeError('job_not_found', input.jobId);
        }
        if (error.code === '23505' || error.code === 'P0001') {
          throw new JobRuntimeError('job_completion_conflict', input.jobId);
        }
        if (error.code === '22023' || error.code === '23514') {
          throw new JobRuntimeError('invalid_agent_completion', input.jobId);
        }
      }
      throw new JobRuntimeError('job_completion_failed', input.jobId);
    }

    if (result.completed) {
      this.dependencies.broadcast(result.job.documentName, jobStatusMessage(result.job));
    }
    return result;
  }

  async recoverOnStartup(staleAfterMs: number): Promise<RecoveryResult> {
    const result: RecoveryResult = { queuedDispatched: 0, queuedFailed: 0, staleFailed: 0 };
    const staleBefore = new Date(this.now().getTime() - staleAfterMs).toISOString();
    const staleJobs = await this.dependencies.store.listStaleActiveJobs(
      staleBefore,
      RECOVERY_BATCH_SIZE,
    );
    for (const stale of staleJobs) {
      const current = await this.dependencies.store.getAgentJob(stale.jobId);
      if (!current || (current.status !== 'planning' && current.status !== 'writing')) continue;
      const failed = await this.failJob(
        current,
        current.status,
        'stale_active_job',
        '서버 재시작 후 안전하게 재개할 수 없어 작업을 종료했습니다.',
      );
      if (failed.status === 'error') result.staleFailed += 1;
    }

    const queuedJobs = await this.dependencies.store.listQueuedJobs(RECOVERY_BATCH_SIZE);
    for (const queued of queuedJobs) {
      const current = await this.dependencies.store.getAgentJob(queued.jobId);
      if (!current || current.status !== 'queued') continue;
      const requested = await this.dependencies.store.getAuditEvent(
        current.documentName,
        `job:${current.jobId}:requested`,
      );
      const state = requested ? await this.dependencies.documentStore.load(current.documentName) : null;
      const request =
        requested?.eventType === 'ai_job_requested' && state
          ? recoverRequestFromState(current, state, requested.actorNameSnapshot)
          : null;
      if (!request) {
        const failed = await this.failJob(
          current,
          'queued',
          'recovery_payload_unavailable',
          '재시작 후 요청 내용을 안전하게 복원할 수 없어 작업을 종료했습니다.',
        );
        if (failed.status === 'error') result.queuedFailed += 1;
        continue;
      }

      const latest = await this.dependencies.store.getAgentJob(current.jobId);
      if (!latest || latest.status !== 'queued') continue;
      try {
        await this.dependencies.dispatchJob(request);
        result.queuedDispatched += 1;
      } catch {
        const failed = await this.failJob(
          latest,
          'queued',
          'dispatch_failed',
          'AI 작업을 시작하지 못했습니다.',
        );
        if (failed.status === 'error') result.queuedFailed += 1;
      }
    }
    return result;
  }

  private async appendFailedAudit(job: AgentJob): Promise<void> {
    await this.dependencies.store.appendAuditEvent({
      documentName: job.documentName,
      eventKey: `job:${job.jobId}:failed`,
      eventType: 'ai_job_failed',
      actorId: DEFAULT_AGENT_ACTOR_ID,
      actorNameSnapshot: AGENT_USER.name,
      jobId: job.jobId,
      metadata: { errorCode: job.lastErrorCode ?? 'unknown_failure' },
    });
  }

  private async failJob(
    job: AgentJob,
    expectedStatus: AgentJobStatus,
    errorCode: string,
    errorMessage: string,
  ): Promise<AgentJob> {
    let failed: AgentJob;
    try {
      failed = await this.dependencies.store.transitionAgentJob({
        jobId: job.jobId,
        expectedStatus,
        nextStatus: 'error',
        errorCode,
        errorMessage,
      });
    } catch (error) {
      if (error instanceof JobAuditDatabaseError && error.code === 'P0001') {
        return (await this.dependencies.store.getAgentJob(job.jobId)) ?? job;
      }
      return job;
    }
    try {
      await this.appendFailedAudit(failed);
    } catch {
      // A terminal error row is safer than dispatching an un-audited job.
    }
    this.dependencies.broadcast(failed.documentName, jobStatusMessage(failed));
    return failed;
  }
}
