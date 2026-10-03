import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AGENT_SECRET_HEADER,
  type AgentJobCompletionRequest,
  type AgentJobCompletionResponse,
  type AgentJobTransitionRequest,
  type AgentJobTransitionResponse,
} from '@co-pen/shared';
import type { ActorStore } from './actors';
import { authenticateGuestCredential, GuestAuthenticationError } from './authentication';
import type { JobAuditStore } from './job-audit-store';
import {
  DurableJobRuntime,
  JobRuntimeError,
  MAX_SANITIZED_OUTPUT_CHARS,
  jobStatusMessage,
} from './job-runtime';
import type { DocumentStore } from './persistence';

const MAX_REQUEST_BYTES = 32 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/;
const INTERNAL_STATUS_PATH = '/internal/agent-jobs/status';
const INTERNAL_COMPLETION_PATH = '/internal/agent-jobs/complete';
const MODEL_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/;

interface JobRequestHandlerDependencies {
  runtime: Pick<DurableJobRuntime, 'transitionFromWorker' | 'completeFromWorker'> | null;
  store: JobAuditStore | null;
  documentStore: DocumentStore;
  actorStore: ActorStore;
  guestTokenSecret: string;
  agentSharedSecret: string;
}

function writeJson(response: ServerResponse, status: number, value: unknown, cors = false) {
  response.writeHead(status, {
    ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  return /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] ?? null;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request_too_large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function documentJobsPath(pathname: string): string | null {
  const match = /^\/documents\/([^/]+)\/agent-jobs$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return '';
  }
}

export function parseWorkerTransition(value: unknown): AgentJobTransitionRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.jobId !== 'string' ||
    !UUID_PATTERN.test(input.jobId) ||
    typeof input.documentName !== 'string' ||
    !input.documentName ||
    input.documentName.length > 256
  ) {
    return null;
  }
  const pair = `${String(input.expectedStatus)}:${String(input.nextStatus)}`;
  if (!['queued:planning', 'planning:writing', 'queued:error', 'planning:error', 'writing:error'].includes(pair)) {
    return null;
  }
  if (input.nextStatus === 'error') {
    if (
      input.errorCode !== undefined &&
      (typeof input.errorCode !== 'string' ||
        input.errorCode.length > 128 ||
        !ERROR_CODE_PATTERN.test(input.errorCode))
    ) {
      return null;
    }
    if (
      input.errorMessage !== undefined &&
      (typeof input.errorMessage !== 'string' || input.errorMessage.length > 2000)
    ) {
      return null;
    }
  } else if (input.errorCode !== undefined || input.errorMessage !== undefined) {
    return null;
  }
  return input as unknown as AgentJobTransitionRequest;
}

export function parseWorkerCompletion(value: unknown): AgentJobCompletionRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.jobId !== 'string' ||
    !UUID_PATTERN.test(input.jobId) ||
    typeof input.documentName !== 'string' ||
    !input.documentName ||
    input.documentName.length > 256 ||
    typeof input.sanitizedOutput !== 'string' ||
    input.sanitizedOutput.length < 1 ||
    input.sanitizedOutput.length > MAX_SANITIZED_OUTPUT_CHARS ||
    typeof input.modelProvider !== 'string' ||
    input.modelProvider.length > 100 ||
    !MODEL_PROVIDER_PATTERN.test(input.modelProvider) ||
    typeof input.modelName !== 'string' ||
    input.modelName.length < 1 ||
    input.modelName.length > 200 ||
    input.modelName.trim() !== input.modelName ||
    'outputHash' in input
  ) {
    return null;
  }
  return input as unknown as AgentJobCompletionRequest;
}

export function createJobRequestHandler(dependencies: JobRequestHandlerDependencies) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const documentName = documentJobsPath(pathname);

    if (documentName !== null) {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Headers': 'authorization',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        response.end();
        return true;
      }
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' }, true);
        return true;
      }
      const token = bearerToken(request);
      if (!token) {
        writeJson(response, 401, { error: 'invalid_guest_token' }, true);
        return true;
      }
      try {
        await authenticateGuestCredential(
          token,
          dependencies.guestTokenSecret,
          dependencies.actorStore,
        );
      } catch (error) {
        if (
          error instanceof GuestAuthenticationError &&
          error.code === 'identity_validation_unavailable'
        ) {
          console.error('[identity] actor validation unavailable');
          writeJson(response, 503, { error: 'identity_validation_unavailable' }, true);
          return true;
        }
        writeJson(response, 401, { error: 'invalid_guest_token' }, true);
        return true;
      }
      try {
        if (!documentName || !(await dependencies.documentStore.exists(documentName))) {
          writeJson(response, 404, { error: 'document_not_found' }, true);
          return true;
        }
        if (!dependencies.store) {
          writeJson(response, 503, { error: 'durable_jobs_unavailable' }, true);
          return true;
        }
        const jobs = await dependencies.store.listDocumentJobs(documentName, 20);
        writeJson(
          response,
          200,
          {
            jobs: jobs.map((job) => ({ ...jobStatusMessage(job), createdAt: job.createdAt })),
          },
          true,
        );
      } catch {
        writeJson(response, 503, { error: 'job_status_unavailable' }, true);
      }
      return true;
    }

    if (pathname !== INTERNAL_STATUS_PATH && pathname !== INTERNAL_COMPLETION_PATH) return false;
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'method_not_allowed' });
      return true;
    }
    if (request.headers[AGENT_SECRET_HEADER] !== dependencies.agentSharedSecret) {
      writeJson(response, 401, { error: 'invalid_agent_credential' });
      return true;
    }
    if (!dependencies.runtime) {
      writeJson(response, 503, { error: 'durable_jobs_unavailable' });
      return true;
    }

    let payload: unknown;
    try {
      payload = await readJson(request);
    } catch {
      payload = null;
    }

    if (pathname === INTERNAL_COMPLETION_PATH) {
      const completion = parseWorkerCompletion(payload);
      if (!completion) {
        writeJson(response, 400, { error: 'invalid_request' });
        return true;
      }
      try {
        const result = await dependencies.runtime.completeFromWorker(completion);
        const body: AgentJobCompletionResponse = {
          jobId: result.job.jobId,
          status: 'done',
          completed: result.completed,
        };
        writeJson(response, 200, body);
      } catch (error) {
        if (error instanceof JobRuntimeError && error.code === 'job_not_found') {
          writeJson(response, 404, { error: 'job_not_found' });
        } else if (error instanceof JobRuntimeError && error.code === 'invalid_agent_completion') {
          writeJson(response, 400, { error: 'invalid_request' });
        } else if (error instanceof JobRuntimeError && error.code === 'job_completion_conflict') {
          writeJson(response, 409, { error: 'job_completion_conflict' });
        } else {
          writeJson(response, 503, { error: 'job_completion_failed' });
        }
      }
      return true;
    }

    const transition = parseWorkerTransition(payload);
    if (!transition) {
      writeJson(response, 400, { error: 'invalid_request' });
      return true;
    }

    try {
      const result = await dependencies.runtime.transitionFromWorker(transition);
      const body: AgentJobTransitionResponse = {
        jobId: result.job.jobId,
        status: result.job.status,
        transitioned: result.transitioned,
      };
      writeJson(response, 200, body);
    } catch (error) {
      if (error instanceof JobRuntimeError && error.code === 'job_not_found') {
        writeJson(response, 404, { error: 'job_not_found' });
      } else {
        writeJson(response, 503, { error: 'job_transition_failed' });
      }
    }
    return true;
  };
}
