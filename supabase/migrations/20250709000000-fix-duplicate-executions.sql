-- Fix duplicate n8n executions by updating fingerprint generation and adding better tracking

-- 1. Update fingerprint generation to use 30-second time window instead of 5 minutes
CREATE OR REPLACE FUNCTION public.generate_request_fingerprint(
  p_session_id UUID,
  p_message_content TEXT,
  p_time_window_seconds INTEGER DEFAULT 30  -- Changed from minutes to seconds
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

-- 2. Add more granular status tracking columns
ALTER TABLE public.webhook_requests 
ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_error TEXT;

-- 3. Add index for faster status queries
CREATE INDEX IF NOT EXISTS idx_webhook_requests_status_processing 
ON public.webhook_requests(status, processing_started_at) 
WHERE status = 'processing';

-- 4. Function to clean up stale processing requests (older than 2 minutes)
CREATE OR REPLACE FUNCTION public.cleanup_stale_processing_requests()
RETURNS void
LANGUAGE plpgsql
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

-- 5. Create a scheduled job to run cleanup every minute (if using pg_cron)
-- Note: This requires pg_cron extension. If not available, cleanup can be called from the application
-- SELECT cron.schedule('cleanup-stale-webhook-requests', '* * * * *', 'SELECT public.cleanup_stale_processing_requests();'); 