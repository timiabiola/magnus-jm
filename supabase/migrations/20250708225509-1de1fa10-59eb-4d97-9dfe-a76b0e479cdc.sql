-- Create table for webhook request tracking to prevent duplicate executions
CREATE TABLE public.webhook_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_fingerprint TEXT NOT NULL UNIQUE,
  session_id UUID NOT NULL,
  message_content_hash TEXT NOT NULL,
  idempotency_key UUID NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + INTERVAL '1 hour'),
  n8n_response JSONB,
  error_message TEXT
);

-- Create indexes for performance
CREATE INDEX idx_webhook_requests_fingerprint ON public.webhook_requests(request_fingerprint);
CREATE INDEX idx_webhook_requests_session_id ON public.webhook_requests(session_id);
CREATE INDEX idx_webhook_requests_idempotency_key ON public.webhook_requests(idempotency_key);
CREATE INDEX idx_webhook_requests_expires_at ON public.webhook_requests(expires_at);
CREATE INDEX idx_webhook_requests_status ON public.webhook_requests(status);

-- Enable Row Level Security
ALTER TABLE public.webhook_requests ENABLE ROW LEVEL SECURITY;

-- Create policy to allow all operations (since this is internal request tracking)
CREATE POLICY "Allow all operations on webhook_requests" 
ON public.webhook_requests 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- Create function to clean up expired requests
CREATE OR REPLACE FUNCTION public.cleanup_expired_webhook_requests()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.webhook_requests 
  WHERE expires_at < now();
END;
$$;

-- Create function to generate request fingerprint
CREATE OR REPLACE FUNCTION public.generate_request_fingerprint(
  p_session_id UUID,
  p_message_content TEXT,
  p_time_window_minutes INTEGER DEFAULT 5
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  time_bucket TIMESTAMP WITH TIME ZONE;
  fingerprint_data TEXT;
BEGIN
  -- Round down to the nearest time window to group similar requests
  time_bucket := date_trunc('minute', now()) - 
    (EXTRACT(minute FROM now())::INTEGER % p_time_window_minutes) * INTERVAL '1 minute';
  
  -- Create fingerprint from session + content + time bucket
  fingerprint_data := p_session_id::text || '|' || p_message_content || '|' || time_bucket::text;
  
  -- Return SHA256 hash of the fingerprint data
  RETURN encode(digest(fingerprint_data, 'sha256'), 'hex');
END;
$$;