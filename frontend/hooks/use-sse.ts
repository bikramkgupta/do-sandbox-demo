'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { SSEEvent } from '@/lib/types';

interface UseSSEOptions {
  onEvent?: (event: SSEEvent) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
}

export function useSSE(url: string | null, options: UseSSEOptions = {}) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<SSEEvent[]>([]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    if (!url) {
      disconnect();
      return;
    }

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
      options.onOpen?.();
    };

    eventSource.onerror = (error) => {
      options.onError?.(error);
      // Don't disconnect on error, EventSource will auto-reconnect
    };

    // Listen for all event types
    const eventTypes = ['log', 'status', 'ready', 'complete', 'error', 'keepalive'];

    eventTypes.forEach((type) => {
      eventSource.addEventListener(type, (e) => {
        try {
          const data = e.data ? JSON.parse(e.data) : { type };
          const event = { ...data, type } as SSEEvent;
          setEvents((prev) => [...prev, event]);
          options.onEvent?.(event);
        } catch {
          // Ignore parse errors
        }
      });
    });

    return () => {
      disconnect();
    };
  }, [url, disconnect, options.onEvent, options.onError, options.onOpen]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return { connected, events, disconnect, clearEvents };
}
