
import { useState, useEffect, useCallback, useRef } from 'react';
import { getSessionUUID, generateUUID } from '@/utils/uuid';
import { useToast } from "@/hooks/use-toast";
import { ChatMessage, ChatState, ChatHook } from '@/types/chat';
import { formatResponse } from '@/utils/chatFormatting';
import { sendMessageToWebhook } from '@/services/chatService';

// Stable session ID outside of component state
const stableSessionId = getSessionUUID();

const useChat = (): ChatHook => {
  const [state, setState] = useState<ChatState>({
    messages: [],
    loading: false,
    error: null,
    sessionId: stableSessionId
  });
  const { toast } = useToast();
  
  // Use refs to track request state and prevent race conditions
  const isRequestInProgress = useRef(false);
  const lastRequestTime = useRef(0);
  const abortController = useRef<AbortController | null>(null);
  const MIN_REQUEST_INTERVAL = 1000; // 1 second minimum between requests

  useEffect(() => {
    const savedMessages = localStorage.getItem('chat-messages');
    if (savedMessages) {
      try {
        const parsedMessages = JSON.parse(savedMessages) as ChatMessage[];
        setState(prev => ({ ...prev, messages: parsedMessages }));
      } catch (error) {
        console.error('Error parsing stored messages:', error);
        toast({
          title: "Error",
          description: "Failed to load chat history",
          variant: "destructive"
        });
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('chat-messages', JSON.stringify(state.messages));
  }, [state.messages]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim()) return;
    
    const now = Date.now();
    
    // Rate limiting - prevent rapid successive requests
    if (now - lastRequestTime.current < MIN_REQUEST_INTERVAL) {
      console.log('Rate limited: Request too soon after previous request');
      toast({
        description: "Please wait a moment before sending another message",
        variant: "destructive"
      });
      return;
    }
    
    // Prevent concurrent requests
    if (isRequestInProgress.current) {
      console.log('Request already in progress, ignoring duplicate');
      return;
    }
    
    // Cancel any previous request
    if (abortController.current) {
      abortController.current.abort();
    }
    
    // Create new abort controller for this request
    abortController.current = new AbortController();
    
    const userMessage: ChatMessage = {
      id: generateUUID(),
      content,
      sender: 'user',
      timestamp: now
    };

    // Mark request as in progress
    isRequestInProgress.current = true;
    lastRequestTime.current = now;

    setState(prev => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      loading: true,
      error: null
    }));

    try {
      const data = await sendMessageToWebhook(content, stableSessionId);
      
      // Check if request was aborted
      if (abortController.current?.signal.aborted) {
        console.log('Request was aborted');
        return;
      }
      
      if (!data) {
        throw new Error('Empty response from webhook');
      }

      const formattedResponse = formatResponse(data);
      console.log("Formatted response:", formattedResponse);

      if (!formattedResponse) {
        throw new Error('Could not format webhook response');
      }

      const assistantMessage: ChatMessage = {
        id: generateUUID(),
        content: formattedResponse,
        sender: 'assistant',
        timestamp: Date.now()
      };

      setState(prev => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
        loading: false
      }));

    } catch (error) {
      console.error('Error sending message:', error);
      
      // Don't show errors for aborted requests or duplicates
      if (abortController.current?.signal.aborted || 
          (error instanceof Error && error.message.includes('Duplicate request detected'))) {
        return;
      }
      
      let errorMessage = 'Failed to send message. Please try again.';
      
      if (error instanceof Error) {
        if (error.message.includes('Network Error') || error.message.includes('timeout')) {
          errorMessage = 'Network error: The webhook is currently unreachable. Please check your connection or try again later.';
        } else if (error.message.includes('n8n workflow could not be started')) {
          errorMessage = 'The n8n workflow could not be started. Please check if the workflow is active and properly configured.';
        } else if (!error.message.includes('Duplicate request detected')) {
          errorMessage = error.message;
        }
      }
      
      setState(prev => ({
        ...prev,
        loading: false,
        error: errorMessage
      }));

      if (errorMessage !== 'Failed to send message. Please try again.') {
        toast({
          title: "Error",
          description: errorMessage,
          variant: "destructive"
        });
      }
    } finally {
      // Reset request state
      isRequestInProgress.current = false;
      abortController.current = null;
    }
  }, [toast]);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortController.current) {
        abortController.current.abort();
      }
    };
  }, []);

  const clearMessages = useCallback(() => {
    setState(prev => ({
      ...prev,
      messages: []
    }));
    toast({
      description: "Chat history cleared",
    });
  }, [toast]);

  return {
    messages: state.messages,
    loading: state.loading,
    error: state.error,
    sendMessage,
    clearMessages,
    sessionId: stableSessionId
  };
};

export default useChat;
