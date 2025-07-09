
import { supabase } from '@/integrations/supabase/client';

// Generate deterministic idempotency key based on content + session + time bucket
const generateIdempotencyKey = async (content: string, sessionId: string): Promise<string> => {
  // Create deterministic key from content + session + 90-minute bucket
  // This ensures same content in same session within 90 minutes gets same key
  const timeBucket = Math.floor(Date.now() / (1000 * 60 * 90)); // 90-minute buckets
  const keyData = `${sessionId}|${content.trim()}|${timeBucket}`;
  
  // Generate SHA-256 hash for deterministic idempotency key
  const encoder = new TextEncoder();
  const data = encoder.encode(keyData);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

export const sendMessageToWebhook = async (content: string, sessionId: string): Promise<any> => {
  const idempotencyKey = await generateIdempotencyKey(content, sessionId);
  const requestId = idempotencyKey.substring(0, 8);
  
  console.log(`[${requestId}] Initiating webhook request via proxy - session: ${sessionId.substring(0, 8)}..., deterministic idempotency: ${idempotencyKey.substring(0, 8)}...`);
  
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
