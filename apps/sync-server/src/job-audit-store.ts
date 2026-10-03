import { createClient } from '@supabase/supabase-js';
import type { AgentJobStatus } from '@co-pen/shared';
import type { SyncServerEnvironment } from './config';

export type AgentOperationType = 'insert_after';
export type AuditEventType =
  | 'ai_job_requested'
  | 'ai_job_started'
  | 'ai_output_completed'
  | 'ai_job_failed'
  | 'suggestion_accepted'
  | 'suggestion_rejected';

export interface AgentJob {
  jobId: string;
  documentName: string;
  requestedByActorId: string;
  agentActorId: string;
  status: AgentJobStatus;
  operationType: AgentOperationType;
  idempotencyKey: string;
  promptHash: string;
  modelProvider: string | null;
  modelName: string | null;
  sanitizedOutput: string | null;
  outputHash: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface AuditEvent {
  id: string;
  documentName: string;
  documentSequence: number;
  eventKey: string;
  eventType: AuditEventType;
  actorId: string;
  actorNameSnapshot: string;
  jobId: string | null;
  causationEventId: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
  previousHash: string | null;
  eventHash: string;
  hashVersion: number;
}

export interface CreateAgentJobInput {
  jobId: string;
  documentName: string;
  requestedByActorId: string;
  agentActorId: string;
  operationType: AgentOperationType;
  idempotencyKey: string;
  promptHash: string;
  modelProvider?: string | null;
  modelName?: string | null;
}

export interface TransitionAgentJobInput {
  jobId: string;
  expectedStatus: AgentJobStatus;
  nextStatus: AgentJobStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  outputHash?: string | null;
}

export interface CompleteAgentJobInput {
  jobId: string;
  documentName: string;
  modelProvider: string;
  modelName: string;
  sanitizedOutput: string;
  outputHash: string;
}

export interface AppendAuditEventInput {
  documentName: string;
  eventKey: string;
  eventType: AuditEventType;
  actorId: string;
  actorNameSnapshot: string;
  jobId?: string | null;
  causationEventId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface JobAuditStore {
  createAgentJob(input: CreateAgentJobInput): Promise<{ job: AgentJob; created: boolean }>;
  getAgentJob(jobId: string): Promise<AgentJob | null>;
  getAuditEvent(documentName: string, eventKey: string): Promise<AuditEvent | null>;
  listQueuedJobs(limit?: number): Promise<AgentJob[]>;
  listStaleActiveJobs(staleBefore: string, limit?: number): Promise<AgentJob[]>;
  listDocumentJobs(documentName: string, limit?: number): Promise<AgentJob[]>;
  transitionAgentJob(input: TransitionAgentJobInput): Promise<AgentJob>;
  completeAgentJob(input: CompleteAgentJobInput): Promise<{ job: AgentJob; completed: boolean }>;
  appendAuditEvent(input: AppendAuditEventInput): Promise<AuditEvent>;
}

interface DatabaseResult {
  data: unknown;
  error: unknown;
}

export interface JobAuditDataSource {
  rpc(name: string, parameters: Record<string, unknown>): Promise<DatabaseResult>;
  getAgentJob(jobId: string): Promise<DatabaseResult>;
  getAuditEvent(documentName: string, eventKey: string): Promise<DatabaseResult>;
  listQueuedJobs(limit: number): Promise<DatabaseResult>;
  listStaleActiveJobs(staleBefore: string, limit: number): Promise<DatabaseResult>;
  listDocumentJobs(documentName: string, limit: number): Promise<DatabaseResult>;
}

export class JobAuditDatabaseError extends Error {
  readonly code: string | null;

  constructor(error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : null;
    super('job_audit_database_error');
    this.code = code;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid_${label}_response`);
  }
  return value as Record<string, unknown>;
}

function stringValue(row: Record<string, unknown>, key: string): string {
  if (typeof row[key] !== 'string') throw new Error('invalid_job_audit_response');
  return row[key];
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('invalid_job_audit_response');
  return value;
}

function mapAgentJob(value: unknown): AgentJob {
  const row = record(value, 'agent_job');
  return {
    jobId: stringValue(row, 'job_id'),
    documentName: stringValue(row, 'document_name'),
    requestedByActorId: stringValue(row, 'requested_by_actor_id'),
    agentActorId: stringValue(row, 'agent_actor_id'),
    status: stringValue(row, 'status') as AgentJobStatus,
    operationType: stringValue(row, 'operation_type') as AgentOperationType,
    idempotencyKey: stringValue(row, 'idempotency_key'),
    promptHash: stringValue(row, 'prompt_hash'),
    modelProvider: nullableString(row, 'model_provider'),
    modelName: nullableString(row, 'model_name'),
    sanitizedOutput: nullableString(row, 'sanitized_output'),
    outputHash: nullableString(row, 'output_hash'),
    createdAt: stringValue(row, 'created_at'),
    startedAt: nullableString(row, 'started_at'),
    finishedAt: nullableString(row, 'finished_at'),
    lastErrorCode: nullableString(row, 'last_error_code'),
    lastErrorMessage: nullableString(row, 'last_error_message'),
  };
}

function mapAuditEvent(value: unknown): AuditEvent {
  const row = record(value, 'audit_event');
  const documentSequence = Number(row.document_sequence);
  const hashVersion = Number(row.hash_version);
  if (!Number.isSafeInteger(documentSequence) || !Number.isSafeInteger(hashVersion)) {
    throw new Error('invalid_audit_event_response');
  }
  return {
    id: stringValue(row, 'id'),
    documentName: stringValue(row, 'document_name'),
    documentSequence,
    eventKey: stringValue(row, 'event_key'),
    eventType: stringValue(row, 'event_type') as AuditEventType,
    actorId: stringValue(row, 'actor_id'),
    actorNameSnapshot: stringValue(row, 'actor_name_snapshot'),
    jobId: nullableString(row, 'job_id'),
    causationEventId: nullableString(row, 'causation_event_id'),
    occurredAt: stringValue(row, 'occurred_at'),
    metadata: record(row.metadata, 'audit_metadata'),
    previousHash: nullableString(row, 'previous_hash'),
    eventHash: stringValue(row, 'event_hash'),
    hashVersion,
  };
}

function mapAgentJobs(value: unknown): AgentJob[] {
  if (!Array.isArray(value)) throw new Error('invalid_agent_jobs_response');
  return value.map(mapAgentJob);
}

function boundedLimit(limit = 50): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('invalid_agent_jobs_limit');
  }
  return limit;
}

function throwDatabaseError(error: unknown): asserts error is null | undefined {
  if (error) throw new JobAuditDatabaseError(error);
}

function createSupabaseDataSource(url: string, serviceRoleKey: string): JobAuditDataSource {
  const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  return {
    async rpc(name, parameters) {
      const { data, error } = await supabase.rpc(name, parameters);
      return { data, error };
    },
    async getAgentJob(jobId) {
      const { data, error } = await supabase
        .from('agent_jobs')
        .select('*')
        .eq('job_id', jobId)
        .maybeSingle();
      return { data, error };
    },
    async getAuditEvent(documentName, eventKey) {
      const { data, error } = await supabase
        .from('audit_events')
        .select('*')
        .eq('document_name', documentName)
        .eq('event_key', eventKey)
        .maybeSingle();
      return { data, error };
    },
    async listQueuedJobs(limit) {
      const { data, error } = await supabase
        .from('agent_jobs')
        .select('*')
        .eq('status', 'queued')
        .order('created_at', { ascending: true })
        .limit(limit);
      return { data, error };
    },
    async listStaleActiveJobs(staleBefore, limit) {
      const { data, error } = await supabase
        .from('agent_jobs')
        .select('*')
        .in('status', ['planning', 'writing'])
        .lt('started_at', staleBefore)
        .order('started_at', { ascending: true })
        .limit(limit);
      return { data, error };
    },
    async listDocumentJobs(documentName, limit) {
      const { data, error } = await supabase
        .from('agent_jobs')
        .select('*')
        .eq('document_name', documentName)
        .order('created_at', { ascending: false })
        .limit(limit);
      return { data, error };
    },
  };
}

export function createJobAuditStore(
  environment: SyncServerEnvironment,
  dataSource?: JobAuditDataSource,
): JobAuditStore {
  if (environment.persistenceBackend !== 'supabase') {
    throw new Error('job_audit_requires_supabase');
  }

  const source =
    dataSource ??
    createSupabaseDataSource(
      environment.supabaseUrl!,
      environment.supabaseServiceRoleKey!,
    );

  return {
    async createAgentJob(input) {
      const { data, error } = await source.rpc('create_agent_job', {
        p_job_id: input.jobId,
        p_document_name: input.documentName,
        p_requested_by_actor_id: input.requestedByActorId,
        p_agent_actor_id: input.agentActorId,
        p_operation_type: input.operationType,
        p_idempotency_key: input.idempotencyKey,
        p_prompt_hash: input.promptHash,
        p_model_provider: input.modelProvider ?? null,
        p_model_name: input.modelName ?? null,
      });
      throwDatabaseError(error);
      const result = record(data, 'create_agent_job');
      if (typeof result.created !== 'boolean') throw new Error('invalid_create_agent_job_response');
      return { created: result.created, job: mapAgentJob(result.job) };
    },

    async getAgentJob(jobId) {
      const { data, error } = await source.getAgentJob(jobId);
      throwDatabaseError(error);
      return data === null ? null : mapAgentJob(data);
    },

    async getAuditEvent(documentName, eventKey) {
      const { data, error } = await source.getAuditEvent(documentName, eventKey);
      throwDatabaseError(error);
      return data === null ? null : mapAuditEvent(data);
    },

    async listQueuedJobs(limit) {
      const { data, error } = await source.listQueuedJobs(boundedLimit(limit));
      throwDatabaseError(error);
      return mapAgentJobs(data);
    },

    async listStaleActiveJobs(staleBefore, limit) {
      if (!Number.isFinite(Date.parse(staleBefore))) throw new Error('invalid_stale_before');
      const { data, error } = await source.listStaleActiveJobs(
        staleBefore,
        boundedLimit(limit),
      );
      throwDatabaseError(error);
      return mapAgentJobs(data);
    },

    async listDocumentJobs(documentName, limit) {
      const { data, error } = await source.listDocumentJobs(
        documentName,
        boundedLimit(limit),
      );
      throwDatabaseError(error);
      return mapAgentJobs(data);
    },

    async transitionAgentJob(input) {
      const { data, error } = await source.rpc('transition_agent_job', {
        p_job_id: input.jobId,
        p_expected_status: input.expectedStatus,
        p_next_status: input.nextStatus,
        p_error_code: input.errorCode ?? null,
        p_error_message: input.errorMessage ?? null,
        p_output_hash: input.outputHash ?? null,
      });
      throwDatabaseError(error);
      return mapAgentJob(data);
    },

    async completeAgentJob(input) {
      const { data, error } = await source.rpc('complete_agent_job', {
        p_job_id: input.jobId,
        p_document_name: input.documentName,
        p_model_provider: input.modelProvider,
        p_model_name: input.modelName,
        p_sanitized_output: input.sanitizedOutput,
        p_output_hash: input.outputHash,
      });
      throwDatabaseError(error);
      const result = record(data, 'complete_agent_job');
      if (typeof result.completed !== 'boolean') {
        throw new Error('invalid_complete_agent_job_response');
      }
      return { completed: result.completed, job: mapAgentJob(result.job) };
    },

    async appendAuditEvent(input) {
      const { data, error } = await source.rpc('append_audit_event', {
        p_document_name: input.documentName,
        p_event_key: input.eventKey,
        p_event_type: input.eventType,
        p_actor_id: input.actorId,
        p_actor_name_snapshot: input.actorNameSnapshot,
        p_job_id: input.jobId ?? null,
        p_causation_event_id: input.causationEventId ?? null,
        p_metadata: input.metadata ?? {},
      });
      throwDatabaseError(error);
      return mapAuditEvent(data);
    },
  };
}
