
import { useState, useEffect, useCallback } from 'react';
import { getSessionUUID, generateUUID } from '@/utils/uuid';
import { useToast } from "@/hooks/use-toast";
import { ChatMessage, ChatState, ChatHook } from '@/types/chat';
import { formatResponse } from '@/utils/chatFormatting';
import { sendMessageToWebhook } from '@/services/chatService';

const useChat = (): ChatHook => {
  const [state, setState] = useState<ChatState>({
    messages: [],
    loading: false,
    error: null,
    sessionId: getSessionUUID()
  });
  const { toast } = useToast();

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

    const userMessage: ChatMessage = {
      id: generateUUID(),
      content,
      sender: 'user',
      timestamp: Date.now()
    };

    setState(prev => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      loading: true,
      error: null
    }));

    try {
      const data = await sendMessageToWebhook(content, state.sessionId);
      
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
      
      let errorMessage = 'Failed to send message. Please try again.';
      
      if (error instanceof Error) {
        if (error.message.includes('Network Error') || error.message.includes('timeout')) {
          errorMessage = 'Network error: The webhook is currently unreachable. Please check your connection or try again later.';
        } else if (error.message.includes('n8n workflow could not be started')) {
          errorMessage = 'The n8n workflow could not be started. Please check if the workflow is active and properly configured.';
        } else {
          errorMessage = error.message;
        }
      }
      
      setState(prev => ({
        ...prev,
        loading: false,
        error: errorMessage
      }));

      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive"
      });
    }
  }, [state.sessionId, toast]);

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
    sessionId: state.sessionId
  };
};

export default useChat;
