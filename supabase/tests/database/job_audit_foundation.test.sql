BEGIN;

SELECT plan(67);

CREATE FUNCTION pg_temp.raises_sqlstate(command text, expected text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE command;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE = expected;
END;
$$;

SELECT has_table('public', 'agent_jobs', 'agent_jobs exists');
SELECT has_table('public', 'audit_events', 'audit_events exists');
SELECT has_table('public', 'document_audit_heads', 'document_audit_heads exists');
SELECT has_column('public', 'agent_jobs', 'sanitized_output', 'sanitized_output exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.agent_jobs'::regclass), 'agent_jobs RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.audit_events'::regclass), 'audit_events RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.document_audit_heads'::regclass), 'document_audit_heads RLS enabled');
SELECT is((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('agent_jobs', 'audit_events', 'document_audit_heads')), 0::bigint, 'new tables have no browser policies');
SELECT ok(to_regprocedure('public.create_agent_job(uuid,text,uuid,uuid,text,text,text,text,text)') IS NOT NULL, 'create_agent_job exists');
SELECT ok(to_regprocedure('public.transition_agent_job(uuid,text,text,text,text,text)') IS NOT NULL, 'transition_agent_job exists');
SELECT ok(to_regprocedure('public.append_audit_event(text,text,text,uuid,text,uuid,uuid,jsonb)') IS NOT NULL, 'append_audit_event exists');
SELECT ok(to_regprocedure('public.complete_agent_job(uuid,text,text,text,text,text)') IS NOT NULL, 'complete_agent_job exists');
SELECT ok(
  (SELECT prosecdef FROM pg_proc WHERE oid = 'public.complete_agent_job(uuid,text,text,text,text,text)'::regprocedure),
  'complete_agent_job is SECURITY DEFINER'
);
SELECT ok(
  (SELECT 'search_path=pg_catalog, pg_temp' = ANY(proconfig) FROM pg_proc WHERE oid = 'public.complete_agent_job(uuid,text,text,text,text,text)'::regprocedure),
  'complete_agent_job has a fixed search_path'
);

INSERT INTO public.documents (name, state)
VALUES ('db-test-doc-1', 'AAA='), ('db-test-doc-2', 'AAA='), ('db-test-doc-3', 'AAA=');

INSERT INTO public.actors (id, kind)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'anonymous');

SELECT lives_ok(
  $$
    INSERT INTO public.agent_jobs (
      job_id, document_name, requested_by_actor_id, agent_actor_id,
      operation_type, idempotency_key, prompt_hash
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'db-test-doc-1',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001',
      'insert_after', 'base-key', repeat('a', 64)
    )
  $$,
  'valid job insert succeeds'
);

SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, operation_type, idempotency_key, prompt_hash) VALUES ('10000000-0000-4000-8000-000000000002', 'missing-doc', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'insert_after', 'missing-doc', repeat('a', 64))$$,
  '23503'
), 'missing document is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, operation_type, idempotency_key, prompt_hash) VALUES ('10000000-0000-4000-8000-000000000003', 'db-test-doc-1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-4000-8000-000000000001', 'insert_after', 'missing-requester', repeat('a', 64))$$,
  '23503'
), 'missing requester is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, operation_type, idempotency_key, prompt_hash) VALUES ('10000000-0000-4000-8000-000000000004', 'db-test-doc-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'insert_after', 'missing-agent', repeat('a', 64))$$,
  '23503'
), 'missing agent actor is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, status, operation_type, idempotency_key, prompt_hash) VALUES ('10000000-0000-4000-8000-000000000005', 'db-test-doc-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'bogus', 'insert_after', 'bad-status', repeat('a', 64))$$,
  '23514'
), 'invalid status is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, operation_type, idempotency_key, prompt_hash) VALUES ('10000000-0000-4000-8000-000000000006', 'db-test-doc-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'rewrite', 'bad-operation', repeat('a', 64))$$,
  '23514'
), 'non-executable operation is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, operation_type, idempotency_key, prompt_hash) VALUES ('10000000-0000-4000-8000-000000000007', 'db-test-doc-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'insert_after', 'base-key', repeat('a', 64))$$,
  '23505'
), 'same document idempotency key is unique');
SELECT lives_ok(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, operation_type, idempotency_key, prompt_hash) VALUES ('10000000-0000-4000-8000-000000000008', 'db-test-doc-2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'insert_after', 'base-key', repeat('a', 64))$$,
  'same idempotency key is allowed in another document'
);
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, status, operation_type, idempotency_key, prompt_hash, started_at, finished_at) VALUES ('10000000-0000-4000-8000-000000000009', 'db-test-doc-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'done', 'insert_after', 'bad-time', repeat('a', 64), '2026-10-02 02:00:00+00', '2026-10-02 01:00:00+00')$$,
  '23514'
), 'finished_at before started_at is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, operation_type, idempotency_key, prompt_hash) VALUES ('10000000-0000-4000-8000-000000000010', 'db-test-doc-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'insert_after', 'bad-prompt-hash', 'ABC')$$,
  '23514'
), 'invalid prompt hash is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, operation_type, idempotency_key, prompt_hash, output_hash) VALUES ('10000000-0000-4000-8000-000000000011', 'db-test-doc-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'insert_after', 'bad-output-hash', repeat('a', 64), 'ABC')$$,
  '23514'
), 'invalid output hash is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.agent_jobs (job_id, document_name, requested_by_actor_id, agent_actor_id, status, operation_type, idempotency_key, prompt_hash, finished_at, last_error_code) VALUES ('10000000-0000-4000-8000-000000000012', 'db-test-doc-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'error', 'insert_after', 'bad-error-code', repeat('a', 64), now(), 'NOT ALLOWED')$$,
  '23514'
), 'invalid error code is rejected');

INSERT INTO public.agent_jobs (
  job_id, document_name, requested_by_actor_id, agent_actor_id,
  operation_type, idempotency_key, prompt_hash
) VALUES (
  '10000000-0000-4000-8000-000000000013', 'db-test-doc-3',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001',
  'insert_after', 'completion-key', repeat('a', 64)
);

SELECT lives_ok(
  $$SELECT public.transition_agent_job('10000000-0000-4000-8000-000000000013', 'queued', 'planning')$$,
  'completion job enters planning'
);
SELECT lives_ok(
  $$SELECT public.transition_agent_job('10000000-0000-4000-8000-000000000013', 'planning', 'writing')$$,
  'completion job enters writing'
);
SELECT ok(pg_temp.raises_sqlstate(
  $$SELECT public.transition_agent_job('10000000-0000-4000-8000-000000000013', 'writing', 'done')$$,
  '22023'
), 'general transition cannot complete a job');
SELECT lives_ok(
  $$
    SELECT public.complete_agent_job(
      '10000000-0000-4000-8000-000000000013',
      'db-test-doc-3',
      'openai',
      'gpt-test',
      'safe completion',
      encode(extensions.digest(convert_to('safe completion', 'UTF8'), 'sha256'), 'hex')
    )
  $$,
  'writing job completes with provenance'
);
SELECT is(
  (SELECT status FROM public.agent_jobs WHERE job_id = '10000000-0000-4000-8000-000000000013'),
  'done',
  'completion stores done status'
);
SELECT is(
  (SELECT sanitized_output FROM public.agent_jobs WHERE job_id = '10000000-0000-4000-8000-000000000013'),
  'safe completion',
  'completion stores sanitized output'
);
SELECT is(
  (SELECT output_hash FROM public.agent_jobs WHERE job_id = '10000000-0000-4000-8000-000000000013'),
  encode(extensions.digest(convert_to('safe completion', 'UTF8'), 'sha256'), 'hex'),
  'completion stores the UTF-8 SHA-256 hash'
);
SELECT ok(
  (SELECT model_provider = 'openai' AND model_name = 'gpt-test'
     FROM public.agent_jobs
    WHERE job_id = '10000000-0000-4000-8000-000000000013'),
  'completion stores authoritative model provenance'
);
SELECT is(
  (SELECT count(*) FROM public.audit_events WHERE event_key = 'job:10000000-0000-4000-8000-000000000013:completed'),
  1::bigint,
  'completion appends exactly one audit event'
);
SELECT ok(
  (SELECT h.last_sequence = e.document_sequence
          AND h.last_event_hash = e.event_hash
          AND h.last_event_id = e.id
     FROM public.document_audit_heads h
     JOIN public.audit_events e
       ON e.document_name = h.document_name
      AND e.event_key = 'job:10000000-0000-4000-8000-000000000013:completed'
    WHERE h.document_name = 'db-test-doc-3'),
  'completion advances the document hash-chain head'
);
SELECT ok(
  (SELECT metadata = jsonb_build_object(
            'operationType', 'insert_after',
            'outputHash', encode(extensions.digest(convert_to('safe completion', 'UTF8'), 'sha256'), 'hex'),
            'modelProvider', 'openai',
            'modelName', 'gpt-test'
          )
          AND metadata::text NOT LIKE '%safe completion%'
     FROM public.audit_events
    WHERE event_key = 'job:10000000-0000-4000-8000-000000000013:completed'),
  'completion audit has minimal metadata without output text'
);
SELECT lives_ok(
  $$
    SELECT public.complete_agent_job(
      '10000000-0000-4000-8000-000000000013', 'db-test-doc-3', 'openai', 'gpt-test',
      'safe completion', encode(extensions.digest(convert_to('safe completion', 'UTF8'), 'sha256'), 'hex')
    )
  $$,
  'identical completion retry is idempotent'
);
SELECT is(
  (SELECT count(*) FROM public.audit_events WHERE event_key = 'job:10000000-0000-4000-8000-000000000013:completed'),
  1::bigint,
  'completion retry does not duplicate audit events'
);
SELECT ok(pg_temp.raises_sqlstate(
  $$SELECT public.complete_agent_job('10000000-0000-4000-8000-000000000013', 'db-test-doc-3', 'openai', 'different-model', 'safe completion', encode(extensions.digest(convert_to('safe completion', 'UTF8'), 'sha256'), 'hex'))$$,
  '23505'
), 'different duplicate completion conflicts');
SELECT ok(pg_temp.raises_sqlstate(
  $$SELECT public.complete_agent_job('10000000-0000-4000-8000-000000000013', 'db-test-doc-3', 'openai', 'gpt-test', 'safe completion', repeat('b', 64))$$,
  '22023'
), 'output hash mismatch is rejected');

INSERT INTO public.agent_jobs (
  job_id, document_name, requested_by_actor_id, agent_actor_id,
  operation_type, idempotency_key, prompt_hash
) VALUES (
  '10000000-0000-4000-8000-000000000014', 'db-test-doc-3',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001',
  'insert_after', 'non-writing-completion', repeat('a', 64)
);
SELECT ok(pg_temp.raises_sqlstate(
  $$SELECT public.complete_agent_job('10000000-0000-4000-8000-000000000014', 'db-test-doc-3', 'openai', 'gpt-test', 'safe completion', encode(extensions.digest(convert_to('safe completion', 'UTF8'), 'sha256'), 'hex'))$$,
  'P0001'
), 'non-writing completion is rejected');

SELECT lives_ok(
  $$
    INSERT INTO public.audit_events (
      id, document_name, document_sequence, event_key, event_type, actor_id,
      actor_name_snapshot, job_id, occurred_at, metadata, previous_hash, event_hash
    ) VALUES (
      '20000000-0000-4000-8000-000000000001', 'db-test-doc-1', 1, 'audit-valid',
      'ai_job_requested', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Actor',
      '10000000-0000-4000-8000-000000000001', now(), '{}', NULL, repeat('c', 64)
    )
  $$,
  'valid audit event insert satisfies constraints'
);
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.audit_events (id, document_name, document_sequence, event_key, event_type, actor_id, actor_name_snapshot, occurred_at, metadata, previous_hash, event_hash) VALUES ('20000000-0000-4000-8000-000000000002', 'db-test-doc-1', 2, 'bad-event-type', 'human_edit', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Actor', now(), '{}', repeat('c', 64), repeat('d', 64))$$,
  '23514'
), 'invalid event type is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.audit_events (id, document_name, document_sequence, event_key, event_type, actor_id, actor_name_snapshot, occurred_at, metadata, previous_hash, event_hash) VALUES ('20000000-0000-4000-8000-000000000003', 'db-test-doc-1', 0, 'bad-sequence', 'ai_job_requested', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Actor', now(), '{}', NULL, repeat('d', 64))$$,
  '23514'
), 'non-positive sequence is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.audit_events (id, document_name, document_sequence, event_key, event_type, actor_id, actor_name_snapshot, occurred_at, metadata, previous_hash, event_hash) VALUES ('20000000-0000-4000-8000-000000000004', 'db-test-doc-2', 1, 'bad-first-hash', 'ai_job_requested', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Actor', now(), '{}', repeat('c', 64), repeat('d', 64))$$,
  '23514'
), 'first event with previous hash is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.audit_events (id, document_name, document_sequence, event_key, event_type, actor_id, actor_name_snapshot, occurred_at, metadata, previous_hash, event_hash) VALUES ('20000000-0000-4000-8000-000000000005', 'db-test-doc-2', 1, 'bad-metadata', 'ai_job_requested', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Actor', now(), '[]', NULL, repeat('d', 64))$$,
  '23514'
), 'non-object metadata is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.audit_events (id, document_name, document_sequence, event_key, event_type, actor_id, actor_name_snapshot, job_id, occurred_at, metadata, previous_hash, event_hash) VALUES ('20000000-0000-4000-8000-000000000006', 'db-test-doc-2', 1, 'cross-document-job', 'ai_job_requested', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Actor', '10000000-0000-4000-8000-000000000001', now(), '{}', NULL, repeat('d', 64))$$,
  '23503'
), 'job from another document is rejected');
SELECT ok(pg_temp.raises_sqlstate(
  $$INSERT INTO public.audit_events (id, document_name, document_sequence, event_key, event_type, actor_id, actor_name_snapshot, causation_event_id, occurred_at, metadata, previous_hash, event_hash) VALUES ('20000000-0000-4000-8000-000000000007', 'db-test-doc-2', 1, 'cross-document-cause', 'ai_job_requested', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Actor', '20000000-0000-4000-8000-000000000001', now(), '{}', NULL, repeat('d', 64))$$,
  '23503'
), 'causation event from another document is rejected');

SELECT ok(has_table_privilege('service_role', 'public.agent_jobs', 'SELECT'), 'service_role can read jobs');
SELECT ok(NOT has_table_privilege('service_role', 'public.agent_jobs', 'INSERT'), 'service_role cannot directly insert jobs');
SELECT ok(NOT has_table_privilege('service_role', 'public.agent_jobs', 'UPDATE'), 'service_role cannot directly update jobs');
SELECT ok(NOT has_table_privilege('service_role', 'public.audit_events', 'INSERT'), 'service_role cannot directly insert audit events');
SELECT ok(NOT has_table_privilege('service_role', 'public.audit_events', 'UPDATE'), 'service_role cannot update audit events');
SELECT ok(NOT has_table_privilege('service_role', 'public.audit_events', 'DELETE'), 'service_role cannot delete audit events');
SELECT ok(NOT has_table_privilege('service_role', 'public.audit_events', 'TRUNCATE'), 'service_role cannot truncate audit events');
SELECT ok(NOT has_table_privilege('service_role', 'public.document_audit_heads', 'UPDATE'), 'service_role cannot update audit heads');
SELECT ok(NOT has_table_privilege('anon', 'public.agent_jobs', 'SELECT'), 'anon cannot read jobs');
SELECT ok(NOT has_table_privilege('authenticated', 'public.agent_jobs', 'SELECT'), 'authenticated cannot read jobs');
SELECT ok(has_function_privilege('service_role', 'public.create_agent_job(uuid,text,uuid,uuid,text,text,text,text,text)', 'EXECUTE'), 'service_role can create jobs through RPC');
SELECT ok(has_function_privilege('service_role', 'public.transition_agent_job(uuid,text,text,text,text,text)', 'EXECUTE'), 'service_role can transition jobs through RPC');
SELECT ok(has_function_privilege('service_role', 'public.append_audit_event(text,text,text,uuid,text,uuid,uuid,jsonb)', 'EXECUTE'), 'service_role can append audit events through RPC');
SELECT ok(has_function_privilege('service_role', 'public.complete_agent_job(uuid,text,text,text,text,text)', 'EXECUTE'), 'service_role can complete jobs through RPC');
SELECT ok(NOT has_function_privilege('anon', 'public.complete_agent_job(uuid,text,text,text,text,text)', 'EXECUTE'), 'anon cannot execute completion RPC');
SELECT ok(NOT has_function_privilege('authenticated', 'public.complete_agent_job(uuid,text,text,text,text,text)', 'EXECUTE'), 'authenticated cannot execute completion RPC');
SELECT ok(NOT has_function_privilege('anon', 'public.append_audit_event(text,text,text,uuid,text,uuid,uuid,jsonb)', 'EXECUTE'), 'anon cannot execute append RPC');
SELECT ok(NOT has_function_privilege('authenticated', 'public.append_audit_event(text,text,text,uuid,text,uuid,uuid,jsonb)', 'EXECUTE'), 'authenticated cannot execute append RPC');

SELECT * FROM finish();
ROLLBACK;
