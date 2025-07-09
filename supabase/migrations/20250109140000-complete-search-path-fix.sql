-- Complete Search Path Security Fix
-- Fix ALL functions that show Function Search Path Mutable errors

-- 1. Fix match_documents function (multiple variants may exist)
CREATE OR REPLACE FUNCTION public.match_documents(
    query_embedding vector(1536),
    match_count int DEFAULT null,
    filter jsonb DEFAULT '{}'
)
RETURNS TABLE(
    id bigint,
    content text,
    metadata jsonb,
    similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
#variable_conflict use_column
begin
  return query
  select
    documents.id,
    documents.content,
    documents.metadata,
    (1 - (documents.embedding <=> query_embedding))::float as similarity
  from documents
  where documents.metadata @> filter
    and documents.embedding IS NOT NULL
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 2. Fix acquire_session_lock function
CREATE OR REPLACE FUNCTION public.acquire_session_lock(
  p_session_id UUID,
  p_message_content TEXT,
  p_locked_by TEXT,
  p_lock_duration_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  message_hash TEXT;
  lock_acquired BOOLEAN := FALSE;
BEGIN
  message_hash := encode(digest(p_message_content, 'sha256'), 'hex');
  
  BEGIN
    INSERT INTO public.session_locks (session_id, message_hash, locked_by, expires_at)
    VALUES (
      p_session_id, 
      message_hash, 
      p_locked_by, 
      now() + (p_lock_duration_seconds || ' seconds')::interval
    );
    lock_acquired := TRUE;
  EXCEPTION 
    WHEN unique_violation THEN
      UPDATE public.session_locks 
      SET locked_by = p_locked_by,
          locked_at = now(),
          expires_at = now() + (p_lock_duration_seconds || ' seconds')::interval
      WHERE session_id = p_session_id 
        AND message_hash = message_hash
        AND expires_at < now();
      
      GET DIAGNOSTICS lock_acquired = ROW_COUNT;
      lock_acquired := (lock_acquired > 0);
  END;
  
  RETURN lock_acquired;
END;
$$;

-- 3. Fix check_recent_duplicate_request function
CREATE OR REPLACE FUNCTION public.check_recent_duplicate_request(
  p_session_id UUID,
  p_message_content TEXT,
  p_lookback_seconds INTEGER DEFAULT 90
)
RETURNS TABLE (
  existing_id UUID,
  existing_status TEXT,
  time_since_created BIGINT,
  n8n_response JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    wr.id,
    wr.status,
    EXTRACT(epoch FROM (now() - wr.created_at))::BIGINT as time_since_created,
    wr.n8n_response
  FROM public.webhook_requests wr
  WHERE wr.session_id = p_session_id
    AND wr.message_content_hash = encode(digest(p_message_content, 'sha256'), 'hex')
    AND wr.created_at > (now() - (p_lookback_seconds || ' seconds')::interval)
    AND wr.status IN ('processing', 'completed')
  ORDER BY wr.created_at DESC
  LIMIT 1;
END;
$$;

-- 4. Fix cleanup_expired_locks function
CREATE OR REPLACE FUNCTION public.cleanup_expired_locks()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  DELETE FROM public.session_locks 
  WHERE expires_at < now();
END;
$$;

-- 5. Fix cleanup_expired_webhook_requests function
CREATE OR REPLACE FUNCTION public.cleanup_expired_webhook_requests()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  DELETE FROM public.webhook_requests 
  WHERE expires_at < now();
END;
$$;

-- 6. Fix cleanup_old_idempotency_records function (if it exists)
CREATE OR REPLACE FUNCTION public.cleanup_old_idempotency_records()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  -- Clean up old idempotency records
  DELETE FROM public.webhook_requests 
  WHERE created_at < (now() - INTERVAL '24 hours')
    AND status IN ('completed', 'failed');
END;
$$;

-- 7. Fix cleanup_old_webhook_requests function
CREATE OR REPLACE FUNCTION public.cleanup_old_webhook_requests()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  DELETE FROM public.webhook_requests 
  WHERE created_at < (now() - INTERVAL '24 hours')
    AND status IN ('completed', 'failed');
END;
$$;

-- 8. Fix cleanup_old_webhook_requests_enhanced function (if it exists)
CREATE OR REPLACE FUNCTION public.cleanup_old_webhook_requests_enhanced()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  -- Enhanced cleanup with additional logic
  DELETE FROM public.webhook_requests 
  WHERE created_at < (now() - INTERVAL '48 hours')
    AND status IN ('completed', 'failed');
    
  -- Also clean up very old pending/processing requests
  DELETE FROM public.webhook_requests 
  WHERE created_at < (now() - INTERVAL '1 hour')
    AND status IN ('pending', 'processing');
END;
$$;

-- 9. Fix cleanup_stale_processing_requests function
CREATE OR REPLACE FUNCTION public.cleanup_stale_processing_requests()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  UPDATE public.webhook_requests 
  SET status = 'failed',
      error_message = 'Processing timeout - marked as failed',
      completed_at = now()
  WHERE status = 'processing' 
    AND processing_started_at < (now() - INTERVAL '2 minutes');
END;
$$;

-- 10. Fix generate_request_fingerprint function
CREATE OR REPLACE FUNCTION public.generate_request_fingerprint(
  p_session_id UUID,
  p_message_content TEXT,
  p_time_window_seconds INTEGER DEFAULT 30
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  time_bucket TIMESTAMP WITH TIME ZONE;
  fingerprint_data TEXT;
BEGIN
  time_bucket := date_trunc('second', now()) - 
    ((EXTRACT(epoch FROM now())::INTEGER % p_time_window_seconds) * INTERVAL '1 second');
  
  fingerprint_data := p_session_id::text || '|' || p_message_content || '|' || time_bucket::text;
  
  RETURN encode(digest(fingerprint_data, 'sha256'), 'hex');
END;
$$;

-- 11. Fix release_session_lock function
CREATE OR REPLACE FUNCTION public.release_session_lock(
  p_session_id UUID,
  p_message_content TEXT,
  p_locked_by TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  message_hash TEXT;
  lock_released BOOLEAN := FALSE;
BEGIN
  message_hash := encode(digest(p_message_content, 'sha256'), 'hex');
  
  DELETE FROM public.session_locks 
  WHERE session_id = p_session_id 
    AND message_hash = message_hash
    AND locked_by = p_locked_by;
    
  GET DIAGNOSTICS lock_released = ROW_COUNT;
  RETURN (lock_released > 0);
END;
$$;

-- 12. Fix update_webhook_requests_content_hash function
CREATE OR REPLACE FUNCTION public.update_webhook_requests_content_hash()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  UPDATE public.webhook_requests 
  SET content_hash = encode(digest(message_content_hash, 'sha256'), 'hex')
  WHERE content_hash IS NULL;
END;
$$;

-- 13. Grant permissions
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- 14. Log completion
DO $$
BEGIN
  RAISE NOTICE 'Complete search_path security fix applied to ALL functions';
  RAISE NOTICE 'All Function Search Path Mutable errors should now be resolved';
END;
$$; 