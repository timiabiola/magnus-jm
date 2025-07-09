import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const N8N_WEBHOOK_URL = 'https://n8n.enlightenedmediacollective.com/webhook/ad505cea-f7a4-497b-ba94-cedead6022f3';

interface WebhookRequest {
  content: string;
  sessionId: string;
  idempotencyKey: string;
}

const executeN8NRequest = async (content: string, sessionId: string, requestId: string): Promise<any> => {
  console.log(`[${requestId}] Sending to n8n:`, content.substring(0, 50) + '...');
  
  const queryParams = new URLSearchParams({
    UUID: sessionId,
    message: content,
    requestId: requestId
  }).toString();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 40000);

  try {
    const response = await fetch(`${N8N_WEBHOOK_URL}?${queryParams}`, {
      headers: { 'Content-Type': 'application/json' },
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
};

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { 
      status: 405, 
      headers: corsHeaders 
    });
  }

  try {
    const { content, sessionId, idempotencyKey }: WebhookRequest = await req.json();
    const requestId = crypto.randomUUID().substring(0, 8);
    
    console.log(`[${requestId}] Minimal webhook proxy - session: ${sessionId.substring(0, 8)}`);

    // Basic validation
    if (!content?.trim() || !sessionId || !idempotencyKey) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: content, sessionId, idempotencyKey' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Simple duplicate check using just idempotency_key
    try {
      const { data: existingRequest } = await supabase
        .from('webhook_requests')
        .select('id, status, n8n_response, created_at')
        .eq('idempotency_key', idempotencyKey)
        .gte('created_at', new Date(Date.now() - 90 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingRequest) {
        console.log(`[${requestId}] Found existing request:`, existingRequest.id);
        
        if (existingRequest.status === 'completed' && existingRequest.n8n_response) {
          console.log(`[${requestId}] Returning cached response`);
          return new Response(JSON.stringify(existingRequest.n8n_response), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        
        if (existingRequest.status === 'processing') {
          return new Response(JSON.stringify({ 
            error: 'Request already processing' 
          }), {
            status: 409,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }
    } catch (dbError) {
      console.warn(`[${requestId}] Database check failed, proceeding:`, dbError);
      // Continue without duplicate checking if database fails
    }

    // Execute n8n request
    const n8nResponse = await executeN8NRequest(content, sessionId, requestId);
    
    // Try to save result (don't fail if this doesn't work)
    try {
      await supabase
        .from('webhook_requests')
        .upsert({
          idempotency_key: idempotencyKey,
          session_id: sessionId,
          message_content_hash: idempotencyKey,
          status: 'completed',
          n8n_response: n8nResponse,
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        });
    } catch (saveError) {
      console.warn(`[${requestId}] Failed to save result:`, saveError);
      // Continue anyway - the n8n request succeeded
    }

    return new Response(JSON.stringify(n8nResponse), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Webhook proxy error:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Internal server error',
        details: error instanceof Error ? error.stack : undefined
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
};

serve(handler); 