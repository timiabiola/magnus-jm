
import axios from 'axios';

const N8N_WEBHOOK_URL = 'https://n8n.enlightenedmediacollective.com/webhook/ad505cea-f7a4-497b-ba94-cedead6022f3';
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000; // 1 second

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const sendMessageToWebhook = async (content: string, sessionId: string, retryCount = 0): Promise<any> => {
  try {
    console.log(`Sending message to webhook (attempt ${retryCount + 1}):`, content);
    
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

    console.log("Webhook response:", response.data);
    return response.data;
  } catch (error) {
    console.error(`Error in attempt ${retryCount + 1}:`, error);
    
    if (axios.isAxiosError(error) && error.response?.status === 500) {
      const errorData = error.response.data;
      console.log("Server error response:", errorData);
      
      if (errorData?.message?.includes("Workflow could not be started")) {
        throw new Error("The n8n workflow could not be started. Please check if the workflow is active and properly configured.");
      }
    }
    
    if (retryCount < MAX_RETRIES) {
      console.log(`Retrying... (${retryCount + 1}/${MAX_RETRIES})`);
      await delay(RETRY_DELAY * (retryCount + 1));
      return sendMessageToWebhook(content, sessionId, retryCount + 1);
    }
    
    throw error;
  }
};
