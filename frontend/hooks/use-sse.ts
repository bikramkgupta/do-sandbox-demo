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
  const [connectionError, setConnectionError] = useState<string | null>(null);

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

    console.log('[SSE] Connecting to:', url);
    setConnectionError(null);

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      console.log('[SSE] Connected');
      setConnected(true);
      setConnectionError(null);
      options.onOpen?.();
    };

    eventSource.onerror = (error) => {
      console.error('[SSE] Error:', error);
      setConnectionError('Connection error - retrying...');
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
          console.log('[SSE] Received event:', type, data);
          setEvents((prev) => [...prev, event]);
          options.onEvent?.(event);
        } catch (parseError) {
          console.warn('[SSE] Parse error for event:', type, e.data, parseError);
        }
      });
    });

    // Also listen for generic 'message' events in case backend sends untyped events
    eventSource.onmessage = (e) => {
      try {
        const data = e.data ? JSON.parse(e.data) : {};
        console.log('[SSE] Generic message:', data);
        if (data.type) {
          const event = data as SSEEvent;
          setEvents((prev) => [...prev, event]);
          options.onEvent?.(event);
        }
      } catch {
        // Ignore
      }
    };

    return () => {
      console.log('[SSE] Disconnecting');
      disconnect();
    };
  }, [url, disconnect, options.onEvent, options.onError, options.onOpen]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return { connected, events, disconnect, clearEvents, connectionError };
}
