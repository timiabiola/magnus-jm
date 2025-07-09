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

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 40000); // 40 second timeout

    try {
      const response = await fetch(`${N8N_WEBHOOK_URL}?${queryParams}`, {
        headers: {
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`n8n returned ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      console.log(`[${requestId}] n8n response received successfully`);
      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error('Request timeout after 40 seconds');
      }
      throw error;
    }
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

    console.log(`[${requestId}] Processing request - idempotency: ${idempotencyKey.substring(0, 8)}...`);

    // BULLETPROOF SINGLE LAYER: Check if this exact idempotency key was processed recently
    const { data: existingRequest, error: checkError } = await supabase
      .from('webhook_requests')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .gte('created_at', new Date(Date.now() - 90 * 60 * 1000).toISOString()) // 90 minutes
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!checkError && existingRequest) {
      console.log(`[${requestId}] Duplicate idempotency key found:`, {
        existingId: existingRequest.id,
        status: existingRequest.status,
        createdAt: existingRequest.created_at
      });
      
      // Return cached response if completed
      if (existingRequest.status === 'completed' && existingRequest.n8n_response) {
        return new Response(JSON.stringify(existingRequest.n8n_response), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Block if still processing (within 2 minutes)
      const timeSinceCreated = Date.now() - new Date(existingRequest.created_at).getTime();
      if (existingRequest.status === 'processing' && timeSinceCreated < 120000) {
        return new Response(JSON.stringify({ 
          error: 'Request with same idempotency key already processing' 
        }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Create new request record
    const { data: newRequest, error: insertError } = await supabase
      .from('webhook_requests')
      .insert({
        idempotency_key: idempotencyKey,
        session_id: sessionId,
        message_content_hash: idempotencyKey, // Use idempotency key as hash
        status: 'processing',
        processing_started_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      console.error(`[${requestId}] Error creating request record:`, insertError);
      
      // If unique constraint violation, return duplicate error
      if (insertError.code === '23505') {
        return new Response(JSON.stringify({ error: 'Duplicate request' }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      throw new Error('Failed to create request record');
    }

    console.log(`[${requestId}] Created request record: ${newRequest.id}`);

    try {
      // Execute n8n request
      const n8nResponse = await executeN8NRequest(content, sessionId, requestId);
      
      // Update as completed
      await supabase
        .from('webhook_requests')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          n8n_response: n8nResponse
        })
        .eq('id', newRequest.id);

      return new Response(JSON.stringify(n8nResponse), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

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