-- Comprehensive fix for duplicate n8n executions with extended time windows

-- 1. Update fingerprint generation to use 90-second time window (1m 30s)
DROP FUNCTION IF EXISTS public.generate_request_fingerprint(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.generate_request_fingerprint(
  p_session_id UUID,
  p_message_content TEXT,
  p_time_window_seconds INTEGER DEFAULT 90  -- Extended to 90 seconds (1m 30s)
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  time_bucket TIMESTAMP WITH TIME ZONE;
  fingerprint_data TEXT;
BEGIN
  -- Round down to the nearest time window to group similar requests
  time_bucket := date_trunc('second', now()) - 
    ((EXTRACT(epoch FROM now())::INTEGER % p_time_window_seconds) * INTERVAL '1 second');
  
  -- Create fingerprint from session + content + time bucket
  fingerprint_data := p_session_id::text || '|' || p_message_content || '|' || time_bucket::text;
  
  -- Return SHA256 hash of the fingerprint data
  RETURN encode(digest(fingerprint_data, 'sha256'), 'hex');
END;
$$;

-- 2. Create a function to check for recent duplicate requests within session
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

-- 3. Create a distributed lock table for session-based locking
CREATE TABLE IF NOT EXISTS public.session_locks (
  session_id UUID NOT NULL,
  message_hash TEXT NOT NULL,
  locked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  locked_by TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + INTERVAL '2 minutes'),
  PRIMARY KEY (session_id, message_hash)
);

-- Create index for lock cleanup
CREATE INDEX IF NOT EXISTS idx_session_locks_expires_at 
ON public.session_locks(expires_at);

-- 4. Function to acquire a distributed lock
CREATE OR REPLACE FUNCTION public.acquire_session_lock(
  p_session_id UUID,
  p_message_content TEXT,
  p_locked_by TEXT,
  p_lock_duration_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  message_hash TEXT;
  lock_acquired BOOLEAN := FALSE;
BEGIN
  message_hash := encode(digest(p_message_content, 'sha256'), 'hex');
  
  -- Try to acquire lock
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
      -- Lock already exists, check if it's expired
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

-- 5. Function to release a distributed lock
CREATE OR REPLACE FUNCTION public.release_session_lock(
  p_session_id UUID,
  p_message_content TEXT,
  p_locked_by TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
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

-- 6. Function to clean up expired locks
CREATE OR REPLACE FUNCTION public.cleanup_expired_locks()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.session_locks 
  WHERE expires_at < now();
END;
$$;

-- 7. Enable RLS on session_locks table
ALTER TABLE public.session_locks ENABLE ROW LEVEL SECURITY;

-- Create policy for session_locks
CREATE POLICY "Allow all operations on session_locks"
ON public.session_locks 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- 8. Update webhook_requests table to store content hash properly
ALTER TABLE public.webhook_requests 
ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Create index for content hash lookups
CREATE INDEX IF NOT EXISTS idx_webhook_requests_session_content 
ON public.webhook_requests(session_id, content_hash, created_at);

-- 9. Function to update existing webhook_requests with content hashes
CREATE OR REPLACE FUNCTION public.update_webhook_requests_content_hash()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.webhook_requests 
  SET content_hash = encode(digest(message_content_hash, 'sha256'), 'hex')
  WHERE content_hash IS NULL;
END;
$$;

-- Run the update function
SELECT public.update_webhook_requests_content_hash(); 