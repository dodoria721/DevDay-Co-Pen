import {
  AGENT_SECRET_HEADER,
  type AgentJobCompletionRequest,
  type AgentJobCompletionResponse,
  type AgentJobTransitionRequest,
  type AgentJobTransitionResponse,
} from '@co-pen/shared';
import { env } from './env';

function syncHttpUrl(pathname: string): URL {
  const url = new URL(env.syncServerUrl);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('invalid_sync_server_url');
  }
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url;
}

function isTransitionResponse(value: unknown): value is AgentJobTransitionResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AgentJobTransitionResponse).jobId === 'string' &&
    typeof (value as AgentJobTransitionResponse).status === 'string' &&
    typeof (value as AgentJobTransitionResponse).transitioned === 'boolean'
  );
}

function isCompletionResponse(value: unknown): value is AgentJobCompletionResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AgentJobCompletionResponse).jobId === 'string' &&
    (value as AgentJobCompletionResponse).status === 'done' &&
    typeof (value as AgentJobCompletionResponse).completed === 'boolean'
  );
}

export async function requestJobTransition(
  request: AgentJobTransitionRequest,
): Promise<AgentJobTransitionResponse> {
  const response = await fetch(syncHttpUrl('/internal/agent-jobs/status'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [AGENT_SECRET_HEADER]: env.agentSharedSecret,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('job_status_callback_failed');
  const body: unknown = await response.json();
  if (!isTransitionResponse(body) || body.jobId !== request.jobId) {
    throw new Error('invalid_job_status_callback_response');
  }
  return body;
}

export async function requestJobCompletion(
  request: AgentJobCompletionRequest,
): Promise<AgentJobCompletionResponse> {
  const response = await fetch(syncHttpUrl('/internal/agent-jobs/complete'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [AGENT_SECRET_HEADER]: env.agentSharedSecret,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('job_completion_callback_failed');
  const body: unknown = await response.json();
  if (!isCompletionResponse(body) || body.jobId !== request.jobId) {
    throw new Error('invalid_job_completion_callback_response');
  }
  return body;
}
