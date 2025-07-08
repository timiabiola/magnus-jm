
import axios from 'axios';

const N8N_WEBHOOK_URL = 'https://n8n.enlightenedmediacollective.com/webhook/ad505cea-f7a4-497b-ba94-cedead6022f3';
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY = 1000; // 1 second base delay
const MAX_RETRY_DELAY = 8000; // 8 second max delay

// Request deduplication cache
const activeRequests = new Map<string, Promise<any>>();
const requestTimestamps = new Map<string, number>();
const DEDUP_WINDOW = 5000; // 5 seconds deduplication window

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Generate unique request ID
const generateRequestId = () => Math.random().toString(36).substring(2, 15);

// Calculate exponential backoff delay with jitter
const getRetryDelay = (attempt: number): number => {
  const exponentialDelay = Math.min(BASE_RETRY_DELAY * Math.pow(2, attempt), MAX_RETRY_DELAY);
  const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
  return Math.floor(exponentialDelay + jitter);
};

export const sendMessageToWebhook = async (content: string, sessionId: string, requestId?: string): Promise<any> => {
  const reqId = requestId || generateRequestId();
  const dedupeKey = `${sessionId}:${content.trim()}`;
  const now = Date.now();
  
  console.log(`[${reqId}] Webhook request initiated for session ${sessionId.substring(0, 8)}...`);
  
  // Check for recent duplicate requests
  const lastRequestTime = requestTimestamps.get(dedupeKey);
  if (lastRequestTime && (now - lastRequestTime) < DEDUP_WINDOW) {
    console.log(`[${reqId}] Duplicate request detected within ${DEDUP_WINDOW}ms, ignoring`);
    throw new Error('Duplicate request detected');
  }
  
  // Check if identical request is already in progress
  if (activeRequests.has(dedupeKey)) {
    console.log(`[${reqId}] Request already in progress, returning existing promise`);
    return activeRequests.get(dedupeKey);
  }
  
  // Mark request timestamp
  requestTimestamps.set(dedupeKey, now);
  
  // Create the request promise
  const requestPromise = executeWebhookRequest(content, sessionId, reqId);
  
  // Store in active requests
  activeRequests.set(dedupeKey, requestPromise);
  
  try {
    const result = await requestPromise;
    return result;
  } finally {
    // Clean up
    activeRequests.delete(dedupeKey);
    // Clean up old timestamps
    cleanupOldTimestamps();
  }
};

const executeWebhookRequest = async (content: string, sessionId: string, requestId: string, retryCount = 0): Promise<any> => {
  try {
    console.log(`[${requestId}] Sending message to webhook (attempt ${retryCount + 1}):`, content.substring(0, 50) + '...');
    
    const queryParams = new URLSearchParams({
      UUID: sessionId,
      message: content
    }).toString();

    const response = await axios.get(`${N8N_WEBHOOK_URL}?${queryParams}`, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 40000 // 40 seconds timeout
    });

    console.log(`[${requestId}] Webhook response received:`, response.data ? 'Success' : 'Empty response');
    return response.data;
  } catch (error) {
    console.error(`[${requestId}] Error in attempt ${retryCount + 1}:`, error);
    
    if (axios.isAxiosError(error) && error.response?.status === 500) {
      const errorData = error.response.data;
      console.log(`[${requestId}] Server error response:`, errorData);
      
      if (errorData?.message?.includes("Workflow could not be started")) {
        throw new Error("The n8n workflow could not be started. Please check if the workflow is active and properly configured.");
      }
    }
    
    if (retryCount < MAX_RETRIES) {
      const retryDelay = getRetryDelay(retryCount);
      console.log(`[${requestId}] Retrying in ${retryDelay}ms... (${retryCount + 1}/${MAX_RETRIES})`);
      await delay(retryDelay);
      return executeWebhookRequest(content, sessionId, requestId, retryCount + 1);
    }
    
    throw error;
  }
};

const cleanupOldTimestamps = () => {
  const now = Date.now();
  const cutoff = now - DEDUP_WINDOW * 2; // Keep timestamps for 2x the dedup window
  
  for (const [key, timestamp] of requestTimestamps.entries()) {
    if (timestamp < cutoff) {
      requestTimestamps.delete(key);
    }
  }
};
