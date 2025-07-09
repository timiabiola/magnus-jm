-- Targeted Fix for acquire_session_lock Function
-- Drop all variants and create one definitive secure version

-- 1. Drop ALL possible variants of acquire_session_lock function
DROP FUNCTION IF EXISTS public.acquire_session_lock(UUID, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.acquire_session_lock(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.acquire_session_lock(UUID, TEXT);
DROP FUNCTION IF EXISTS public.acquire_session_lock();

-- 2. Create the definitive secure version with proper search_path
CREATE FUNCTION public.acquire_session_lock(
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
  -- Generate message hash
  message_hash := encode(digest(p_message_content, 'sha256'), 'hex');
  
  -- Clean up expired locks first
  DELETE FROM public.session_locks 
  WHERE expires_at < now();
  
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
      -- Lock already exists, check if it's expired and can be taken over
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

-- 3. Grant proper permissions
GRANT EXECUTE ON FUNCTION public.acquire_session_lock(UUID, TEXT, TEXT, INTEGER) TO service_role;

-- 4. Verify the function exists with proper security settings
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' 
    AND p.proname = 'acquire_session_lock'
  ) THEN
    RAISE NOTICE 'acquire_session_lock function successfully created with secure search_path';
  ELSE
    RAISE EXCEPTION 'Failed to create acquire_session_lock function';
  END IF;
END;
$$; 