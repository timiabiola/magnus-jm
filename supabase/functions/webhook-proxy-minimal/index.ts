import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

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
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`n8n returned ${response.status}: ${errorText}`);
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
    
    console.log(`[${requestId}] Processing request for session: ${sessionId?.substring(0, 8)}`);

    if (!content?.trim() || !sessionId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: content, sessionId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const n8nResponse = await executeN8NRequest(content, sessionId, requestId);
    
    return new Response(JSON.stringify(n8nResponse), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

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