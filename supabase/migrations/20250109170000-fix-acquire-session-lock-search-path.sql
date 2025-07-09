-- Fix acquire_session_lock Function Search Path Mutable Error
-- The issue is with the search_path syntax - must use = not TO

-- Drop all variants to ensure clean state
DROP FUNCTION IF EXISTS public.acquire_session_lock(UUID, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.acquire_session_lock(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.acquire_session_lock;

-- Create the function with correct search_path syntax (= not TO)
CREATE OR REPLACE FUNCTION public.acquire_session_lock(
    p_session_id UUID,
    p_message_content TEXT,
    p_locked_by TEXT,
    p_lock_duration_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_catalog'
AS $function$
DECLARE
    message_hash TEXT;
    lock_acquired BOOLEAN := FALSE;
BEGIN
    -- Generate consistent hash for message content
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
$function$;

-- Grant proper permissions
GRANT EXECUTE ON FUNCTION public.acquire_session_lock(UUID, TEXT, TEXT, INTEGER) TO service_role;

-- Verify the function was created correctly
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'acquire_session_lock'
    ) THEN
        RAISE NOTICE 'SUCCESS: acquire_session_lock function created with proper search_path security';
    ELSE
        RAISE EXCEPTION 'FAILED: Could not create acquire_session_lock function';
    END IF;
END;
$$;
