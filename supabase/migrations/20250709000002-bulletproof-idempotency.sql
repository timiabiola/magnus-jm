-- Bulletproof idempotency fix: Add unique constraint on idempotency_key

-- 1. Ensure idempotency_key is unique (bulletproof database-level enforcement)
ALTER TABLE public.webhook_requests 
ADD CONSTRAINT IF NOT EXISTS unique_idempotency_key UNIQUE (idempotency_key);

-- 2. Clean up old records periodically to prevent table bloat
CREATE OR REPLACE FUNCTION public.cleanup_old_webhook_requests()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.webhook_requests 
  WHERE created_at < (now() - INTERVAL '24 hours')
    AND status IN ('completed', 'failed');
END;
$$;

-- 3. Add index for faster cleanup queries
CREATE INDEX IF NOT EXISTS idx_webhook_requests_cleanup 
ON public.webhook_requests(created_at, status) 
WHERE status IN ('completed', 'failed');

-- 4. Grant necessary permissions
GRANT EXECUTE ON FUNCTION public.cleanup_old_webhook_requests() TO service_role; 