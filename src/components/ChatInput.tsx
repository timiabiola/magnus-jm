
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Loader2 } from 'lucide-react';

interface ChatInputProps {
  onSendMessage: (message: string) => void;
  isLoading: boolean;
  disabled?: boolean;
}

const ChatInput: React.FC<ChatInputProps> = ({ 
  onSendMessage, 
  isLoading,
  disabled = false
}) => {
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastSubmitTime = useRef(0);
  const DEBOUNCE_DELAY = 500; // 500ms debounce

  // Auto-resize the textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
    }
  }, [message]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    
    const now = Date.now();
    const timeSinceLastSubmit = now - lastSubmitTime.current;
    
    // Debounce submissions
    if (timeSinceLastSubmit < DEBOUNCE_DELAY) {
      console.log('Debounced submission');
      return;
    }
    
    if (message.trim() && !isLoading && !isSubmitting && !disabled) {
      setIsSubmitting(true);
      lastSubmitTime.current = now;
      
      try {
        await onSendMessage(message.trim());
        setMessage('');
        // Reset textarea height
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      } catch (error) {
        console.error('Error in handleSubmit:', error);
      } finally {
        setIsSubmitting(false);
      }
    }
  }, [message, isLoading, isSubmitting, disabled, onSendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="relative flex items-end w-full glass-morphism rounded-xl overflow-hidden">
        <Textarea
          ref={textareaRef}
          placeholder="Type a message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading || isSubmitting || disabled}
          className="min-h-10 max-h-40 glass-input border-0 focus-visible:ring-0 focus-visible:ring-offset-0 resize-none py-3 px-4 pr-14"
        />
        <Button 
          type="submit" 
          size="icon" 
          disabled={isLoading || isSubmitting || !message.trim() || disabled}
          className="absolute right-2 bottom-2 h-8 w-8 bg-primary/90 hover:bg-primary rounded-full transition-colors disabled:opacity-50"
        >
          {(isLoading || isSubmitting) ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </form>
  );
};

export default ChatInput;
