import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const N8N_WEBHOOK_URL = 'https://n8n.enlightenedmediacollective.com/webhook/ad505cea-f7a4-497b-ba94-cedead6022f3';
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 8000;

interface WebhookRequest {
  content: string;
  sessionId: string;
  idempotencyKey: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getRetryDelay = (attempt: number): number => {
  const exponentialDelay = Math.min(BASE_RETRY_DELAY * Math.pow(2, attempt), MAX_RETRY_DELAY);
  const jitter = Math.random() * 0.1 * exponentialDelay;
  return Math.floor(exponentialDelay + jitter);
};

const executeN8NRequest = async (content: string, sessionId: string, requestId: string, retryCount = 0): Promise<any> => {
  try {
    console.log(`[${requestId}] Sending to n8n (attempt ${retryCount + 1}):`, content.substring(0, 50) + '...');
    
    const queryParams = new URLSearchParams({
      UUID: sessionId,
      message: content,
      requestId: requestId, // Add requestId for n8n-side deduplication
      idempotencyKey: requestId
    }).toString();

    const response = await fetch(`${N8N_WEBHOOK_URL}?${queryParams}`, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 40000
    });

    if (!response.ok) {
      throw new Error(`n8n returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    console.log(`[${requestId}] n8n response received successfully`);
    return data;
  } catch (error) {
    console.error(`[${requestId}] n8n request failed (attempt ${retryCount + 1}):`, error);
    
    if (retryCount < MAX_RETRIES) {
      const retryDelay = getRetryDelay(retryCount);
      console.log(`[${requestId}] Retrying in ${retryDelay}ms...`);
      await delay(retryDelay);
      return executeN8NRequest(content, sessionId, requestId, retryCount + 1);
    }
    
    throw error;
  }
};

const handler = async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { 
      status: 405, 
      headers: corsHeaders 
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  try {
    const { content, sessionId, idempotencyKey }: WebhookRequest = await req.json();
    const requestId = crypto.randomUUID().substring(0, 8);
    
    console.log(`[${requestId}] Webhook proxy request - session: ${sessionId.substring(0, 8)}..., idempotency: ${idempotencyKey}`);

    if (!content?.trim() || !sessionId || !idempotencyKey) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: content, sessionId, idempotencyKey' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Generate request fingerprint
    const { data: fingerprintData, error: fingerprintError } = await supabase
      .rpc('generate_request_fingerprint', {
        p_session_id: sessionId,
        p_message_content: content.trim(),
        p_time_window_seconds: 30 // Use 30 seconds instead of default 5 minutes
      });

    if (fingerprintError) {
      console.error(`[${requestId}] Error generating fingerprint:`, fingerprintError);
      throw new Error('Failed to generate request fingerprint');
    }

    const fingerprint = fingerprintData as string;
    console.log(`[${requestId}] Generated fingerprint: ${fingerprint.substring(0, 16)}...`);

    // Check for existing request with same fingerprint or idempotency key
    const { data: existingRequest, error: checkError } = await supabase
      .from('webhook_requests')
      .select('*')
      .or(`request_fingerprint.eq.${fingerprint},idempotency_key.eq.${idempotencyKey}`)
      .gte('expires_at', new Date().toISOString())
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error(`[${requestId}] Error checking existing requests:`, checkError);
      throw new Error('Failed to check for duplicate requests');
    }

    if (existingRequest) {
      console.log(`[${requestId}] Duplicate request detected - status: ${existingRequest.status}`, {
        fingerprint: fingerprint.substring(0, 16),
        idempotencyKey: idempotencyKey.substring(0, 8),
        existingRequestId: existingRequest.id,
        timeSinceCreated: existingRequest.created_at ? Date.now() - new Date(existingRequest.created_at).getTime() : null
      });
      
      if (existingRequest.status === 'completed') {
        console.log(`[${requestId}] Returning cached response`);
        return new Response(
          JSON.stringify(existingRequest.n8n_response),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      if (existingRequest.status === 'processing') {
        // Check if it's a stale processing request
        const processingStartedAt = existingRequest.processing_started_at ? new Date(existingRequest.processing_started_at) : null;
        const processingDuration = processingStartedAt ? Date.now() - processingStartedAt.getTime() : 0;
        
        if (processingDuration > 120000) { // 2 minutes
          console.log(`[${requestId}] Stale processing request detected, marking as failed`);
          await supabase
            .from('webhook_requests')
            .update({
              status: 'failed',
              error_message: 'Processing timeout - marked as failed',
              completed_at: new Date().toISOString()
            })
            .eq('id', existingRequest.id);
        } else {
          return new Response(
            JSON.stringify({ error: 'Request already in progress', requestId: existingRequest.id }),
            { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }
      
      if (existingRequest.status === 'failed') {
        return new Response(
          JSON.stringify({ error: existingRequest.error_message || 'Previous request failed' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Create new request record
    const { data: newRequest, error: insertError } = await supabase
      .from('webhook_requests')
      .insert({
        request_fingerprint: fingerprint,
        session_id: sessionId,
        message_content_hash: fingerprint, // Using fingerprint as hash for now
        idempotency_key: idempotencyKey,
        status: 'processing',
        processing_started_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      console.error(`[${requestId}] Error creating request record:`, insertError);
      
      if (insertError.code === '23505') { // Unique constraint violation
        return new Response(
          JSON.stringify({ error: 'Duplicate request detected' }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      throw new Error('Failed to create request record');
    }

    console.log(`[${requestId}] Created request record: ${newRequest.id}`, {
      fingerprint: fingerprint.substring(0, 16),
      idempotencyKey: idempotencyKey.substring(0, 8)
    });

    try {
      // Execute n8n request
      const n8nResponse = await executeN8NRequest(content, sessionId, requestId);
      
      // Update request as completed - ensure this happens even if there's an error
      const { error: updateError } = await supabase
        .from('webhook_requests')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          n8n_response: n8nResponse,
          retry_count: 1 // Increment retry count
        })
        .eq('id', newRequest.id);

      if (updateError) {
        console.error(`[${requestId}] Error updating request as completed:`, updateError);
        // Continue anyway - the response was successful
      }

      console.log(`[${requestId}] Request completed successfully`);
      return new Response(
        JSON.stringify(n8nResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } catch (n8nError) {
      console.error(`[${requestId}] n8n request failed:`, n8nError);
      
      // Always update request as failed
      const { error: updateError } = await supabase
        .from('webhook_requests')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: n8nError instanceof Error ? n8nError.message : 'Unknown error',
          last_error: JSON.stringify({
            message: n8nError instanceof Error ? n8nError.message : 'Unknown error',
            stack: n8nError instanceof Error ? n8nError.stack : undefined,
            timestamp: new Date().toISOString()
          })
        })
        .eq('id', newRequest.id);

      if (updateError) {
        console.error(`[${requestId}] Error updating request as failed:`, updateError);
      }

      throw n8nError;
    }

  } catch (error) {
    console.error('Webhook proxy error:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Internal server error' 
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
};

serve(handler);