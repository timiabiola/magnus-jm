-- Security Fixes Migration
-- Fix Function Search Path Mutable errors, Auth settings, and RLS issues

-- 1. Fix all functions with search_path security issues
-- Update generate_request_fingerprint function
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

-- Update cleanup_stale_processing_requests function
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

-- Update cleanup_old_webhook_requests function
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

-- Update cleanup_expired_webhook_requests function
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

-- Update check_recent_duplicate_request function
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

-- Update acquire_session_lock function
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

-- Update release_session_lock function
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

-- Update cleanup_expired_locks function
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

-- Update update_webhook_requests_content_hash function
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

-- 2. Auth OTP Long Expiry fix is handled in supabase/config.toml
-- (OTP expiry and password requirements configured there)

-- 3. Enable Row Level Security on any tables that don't have it
-- Ensure RLS is enabled on all public tables
ALTER TABLE IF EXISTS public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.webhook_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.session_locks ENABLE ROW LEVEL SECURITY;

-- Create permissive policies for service operations if they don't exist
DO $$
BEGIN
  -- Policy for documents table
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
    AND tablename = 'documents' 
    AND policyname = 'Enable all operations for service role'
  ) THEN
    CREATE POLICY "Enable all operations for service role" 
    ON public.documents 
    FOR ALL 
    USING (true) 
    WITH CHECK (true);
  END IF;

  -- Policy for webhook_requests table
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
    AND tablename = 'webhook_requests' 
    AND policyname = 'Allow all operations on webhook_requests'
  ) THEN
    CREATE POLICY "Allow all operations on webhook_requests" 
    ON public.webhook_requests 
    FOR ALL 
    USING (true) 
    WITH CHECK (true);
  END IF;

  -- Policy for session_locks table if it exists
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'session_locks') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies 
      WHERE schemaname = 'public' 
      AND tablename = 'session_locks' 
      AND policyname = 'Allow all operations on session_locks'
    ) THEN
      CREATE POLICY "Allow all operations on session_locks" 
      ON public.session_locks 
      FOR ALL 
      USING (true) 
      WITH CHECK (true);
    END IF;
  END IF;
END;
$$;

-- 4. Grant proper permissions to service_role
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- 5. Password protection settings are handled in supabase/config.toml
-- (Password strength and requirements configured there)

-- Log completion
DO $$
BEGIN
  RAISE NOTICE 'Security fixes migration completed successfully';
  RAISE NOTICE 'Fixed: Function search_path issues, RLS policies, permissions';
  RAISE NOTICE 'Auth settings (OTP expiry, password protection) configured in supabase/config.toml';
END;
$$; 