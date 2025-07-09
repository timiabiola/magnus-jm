import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

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
      requestId: requestId,
      idempotencyKey: requestId,
      timestamp: new Date().toISOString()
    }).toString();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 40000);

    try {
      const response = await fetch(`${N8N_WEBHOOK_URL}?${queryParams}`, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `Magnus-Webhook-Proxy/${requestId}`,
          'X-Request-ID': requestId
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`n8n returned ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      console.log(`[${requestId}] n8n response received successfully (${JSON.stringify(data).length} chars)`);
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

  const requestId = crypto.randomUUID().substring(0, 8);

  try {
    const { content, sessionId, idempotencyKey }: WebhookRequest = await req.json();
    
    console.log(`[${requestId}] === WEBHOOK PROXY START ===`);
    console.log(`[${requestId}] Session: ${sessionId.substring(0, 8)}..., Content: ${content.substring(0, 100)}...`);

    // Input validation
    if (!content?.trim() || !sessionId || !idempotencyKey) {
      console.log(`[${requestId}] Missing required fields`);
      return new Response(
        JSON.stringify({ error: 'Missing required fields: content, sessionId, idempotencyKey' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Execute n8n request
    const n8nResponse = await executeN8NRequest(content, sessionId, requestId);

    console.log(`[${requestId}] === WEBHOOK PROXY SUCCESS ===`);
    return new Response(JSON.stringify(n8nResponse), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error(`[${requestId}] === WEBHOOK PROXY ERROR ===`, error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Internal server error',
        requestId: requestId
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
};

serve(handler);