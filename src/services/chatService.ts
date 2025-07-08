
import { supabase } from '@/integrations/supabase/client';

// Generate unique idempotency key for each request
const generateIdempotencyKey = () => crypto.randomUUID();

export const sendMessageToWebhook = async (content: string, sessionId: string): Promise<any> => {
  const idempotencyKey = generateIdempotencyKey();
  const requestId = idempotencyKey.substring(0, 8);
  
  console.log(`[${requestId}] Initiating webhook request via proxy - session: ${sessionId.substring(0, 8)}...`);
  
  try {
    const { data, error } = await supabase.functions.invoke('webhook-proxy', {
      body: {
        content: content.trim(),
        sessionId,
        idempotencyKey
      }
    });

    if (error) {
      console.error(`[${requestId}] Edge function error:`, error);
      
      if (error.message?.includes('duplicate request')) {
        throw new Error('Duplicate request detected');
      }
      
      if (error.message?.includes('already in progress')) {
        throw new Error('Request already in progress');
      }
      
      throw new Error(error.message || 'Webhook proxy failed');
    }

    console.log(`[${requestId}] Webhook proxy response received successfully`);
    return data;
  } catch (error) {
    console.error(`[${requestId}] Webhook request failed:`, error);
    throw error;
  }
};
