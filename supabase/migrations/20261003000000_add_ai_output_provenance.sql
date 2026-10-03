BEGIN;

ALTER TABLE public.agent_jobs
  ADD COLUMN sanitized_output text,
  ADD CONSTRAINT agent_jobs_sanitized_output_check
    CHECK (
      sanitized_output IS NULL
      OR char_length(sanitized_output) BETWEEN 1 AND 4000
    );

-- A successful completion must use complete_agent_job so provenance and its
-- audit event commit together. Keep the signature for compatibility, but close
-- the old writing -> done path.
CREATE OR REPLACE FUNCTION public.transition_agent_job(
  p_job_id uuid,
  p_expected_status text,
  p_next_status text,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL,
  p_output_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_job public.agent_jobs%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_expected_status NOT IN ('queued', 'planning', 'writing', 'done', 'error')
     OR p_next_status NOT IN ('planning', 'writing', 'error') THEN
    RAISE EXCEPTION 'invalid_agent_job_status' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_job
    FROM public.agent_jobs
   WHERE job_id = p_job_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent_job_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_job.status <> p_expected_status THEN
    RAISE EXCEPTION 'agent_job_status_conflict' USING ERRCODE = 'P0001';
  END IF;

  IF NOT (
    (v_job.status = 'queued' AND p_next_status = 'planning')
    OR (v_job.status = 'planning' AND p_next_status = 'writing')
    OR (v_job.status IN ('queued', 'planning', 'writing') AND p_next_status = 'error')
  ) THEN
    RAISE EXCEPTION 'invalid_agent_job_transition' USING ERRCODE = '22023';
  END IF;

  IF p_output_hash IS NOT NULL THEN
    RAISE EXCEPTION 'output_hash_requires_completion_rpc' USING ERRCODE = '22023';
  END IF;

  IF p_next_status = 'error' THEN
    IF p_error_code IS NOT NULL AND (
      char_length(p_error_code) > 128
      OR p_error_code !~ '^[a-z0-9][a-z0-9_.:-]*$'
    ) THEN
      RAISE EXCEPTION 'invalid_agent_job_error_code' USING ERRCODE = '22023';
    END IF;
    IF p_error_message IS NOT NULL AND char_length(p_error_message) > 2000 THEN
      RAISE EXCEPTION 'invalid_agent_job_error_message' USING ERRCODE = '22023';
    END IF;
  ELSIF p_error_code IS NOT NULL OR p_error_message IS NOT NULL THEN
    RAISE EXCEPTION 'error_fields_only_allowed_for_error' USING ERRCODE = '22023';
  END IF;

  v_now := clock_timestamp();

  UPDATE public.agent_jobs
     SET status = p_next_status,
         started_at = CASE
           WHEN p_next_status = 'planning' THEN COALESCE(started_at, v_now)
           ELSE started_at
         END,
         finished_at = CASE WHEN p_next_status = 'error' THEN v_now ELSE NULL END,
         last_error_code = CASE WHEN p_next_status = 'error' THEN p_error_code ELSE NULL END,
         last_error_message = CASE WHEN p_next_status = 'error' THEN p_error_message ELSE NULL END
   WHERE job_id = p_job_id
  RETURNING * INTO v_job;

  RETURN to_jsonb(v_job);
END;
$$;

CREATE FUNCTION public.complete_agent_job(
  p_job_id uuid,
  p_document_name text,
  p_model_provider text,
  p_model_name text,
  p_sanitized_output text,
  p_output_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_job public.agent_jobs%ROWTYPE;
  v_computed_hash text;
BEGIN
  IF p_model_provider IS NULL
     OR char_length(p_model_provider) NOT BETWEEN 1 AND 100
     OR p_model_provider !~ '^[a-z0-9][a-z0-9_.:-]*$' THEN
    RAISE EXCEPTION 'invalid_model_provider' USING ERRCODE = '22023';
  END IF;
  IF p_model_name IS NULL
     OR char_length(p_model_name) NOT BETWEEN 1 AND 200
     OR btrim(p_model_name) IS DISTINCT FROM p_model_name THEN
    RAISE EXCEPTION 'invalid_model_name' USING ERRCODE = '22023';
  END IF;
  IF p_sanitized_output IS NULL
     OR char_length(p_sanitized_output) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'invalid_sanitized_output' USING ERRCODE = '22023';
  END IF;
  IF p_output_hash IS NULL OR p_output_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_agent_job_output_hash' USING ERRCODE = '22023';
  END IF;

  v_computed_hash := encode(
    extensions.digest(convert_to(p_sanitized_output, 'UTF8'), 'sha256'),
    'hex'
  );
  IF v_computed_hash IS DISTINCT FROM p_output_hash THEN
    RAISE EXCEPTION 'agent_job_output_hash_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_job
    FROM public.agent_jobs
   WHERE job_id = p_job_id
   FOR UPDATE;

  IF NOT FOUND OR v_job.document_name IS DISTINCT FROM p_document_name THEN
    RAISE EXCEPTION 'agent_job_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_job.status = 'done' THEN
    IF v_job.model_provider IS DISTINCT FROM p_model_provider
       OR v_job.model_name IS DISTINCT FROM p_model_name
       OR v_job.sanitized_output IS DISTINCT FROM p_sanitized_output
       OR v_job.output_hash IS DISTINCT FROM p_output_hash THEN
      RAISE EXCEPTION 'agent_job_completion_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('completed', false, 'job', to_jsonb(v_job));
  END IF;

  IF v_job.status <> 'writing' THEN
    RAISE EXCEPTION 'agent_job_completion_status_conflict' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.agent_jobs
     SET status = 'done',
         model_provider = p_model_provider,
         model_name = p_model_name,
         sanitized_output = p_sanitized_output,
         output_hash = p_output_hash,
         finished_at = clock_timestamp(),
         last_error_code = NULL,
         last_error_message = NULL
   WHERE job_id = p_job_id
  RETURNING * INTO v_job;

  PERFORM public.append_audit_event(
    p_document_name,
    'job:' || p_job_id::text || ':completed',
    'ai_output_completed',
    v_job.agent_actor_id,
    'Co-Pen AI',
    p_job_id,
    NULL,
    jsonb_build_object(
      'operationType', v_job.operation_type,
      'outputHash', p_output_hash,
      'modelProvider', p_model_provider,
      'modelName', p_model_name
    )
  );

  RETURN jsonb_build_object('completed', true, 'job', to_jsonb(v_job));
END;
$$;

REVOKE ALL ON FUNCTION public.complete_agent_job(uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_agent_job(uuid, text, text, text, text, text)
  TO service_role;

COMMIT;
