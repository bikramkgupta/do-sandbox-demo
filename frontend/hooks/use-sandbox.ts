'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { launchSandbox, deleteSandbox, getStatus, getSandbox } from '@/lib/api';
import { SandboxType, GameType, SandboxInfo, StatusResponse, SSEEvent } from '@/lib/types';
import { useSSE } from './use-sse';

// SSE connection URL:
// - In production (App Platform): use empty string for relative URLs (routing handles it)
// - In local dev: use NEXT_PUBLIC_API_URL or fallback to localhost:8000
const SSE_BASE = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_API_URL ||
     (window.location.hostname === 'localhost' ? 'http://localhost:8000' : ''))
  : '';

interface LaunchState {
  isLaunching: boolean;
  runId: string | null;
  streamUrl: string | null;
  error: string | null;
  status: 'idle' | 'creating' | 'running' | 'failed' | 'completed' | 'deleted';
  ingressUrl: string | null;
  elapsedMs: number;
  bootstrapMs: number | null;
  restoreMs: number | null;
  logs: string[];
}

const initialLaunchState: LaunchState = {
  isLaunching: false,
  runId: null,
  streamUrl: null,
  error: null,
  status: 'idle',
  ingressUrl: null,
  elapsedMs: 0,
  bootstrapMs: null,
  restoreMs: null,
  logs: [],
};

export function useSandbox(type: SandboxType) {
  const [state, setState] = useState<LaunchState>(initialLaunchState);
  const [startTime, setStartTime] = useState<number | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Update elapsed time
  const updateElapsed = useCallback(() => {
    if (startTime && state.status === 'creating') {
      setState((prev) => ({
        ...prev,
        elapsedMs: Date.now() - startTime,
      }));
    }
  }, [startTime, state.status]);

  // Handle SSE events
  const handleEvent = useCallback((event: SSEEvent) => {
    console.log('[useSandbox] SSE event received:', event.type);
    if (event.type === 'log') {
      setState((prev) => ({
        ...prev,
        logs: [...prev.logs, (event as any).message],
      }));
    } else if (event.type === 'status') {
      const status = (event as any).status;
      setState((prev) => ({
        ...prev,
        status: status === 'running' ? 'running' : status === 'failed' ? 'failed' : prev.status,
      }));
    } else if (event.type === 'ready') {
      const readyEvent = event as any;
      console.log('[useSandbox] Sandbox ready!', readyEvent);
      setState((prev) => ({
        ...prev,
        status: 'running',
        ingressUrl: readyEvent.ingress_url,
        elapsedMs: readyEvent.total_ms || readyEvent.bootstrap_ms,
        bootstrapMs: readyEvent.bootstrap_ms,
        restoreMs: readyEvent.restore_ms || null,
        isLaunching: false,
      }));
    }
  }, []);

  // SSE connection
  const { connected, disconnect, connectionError } = useSSE(
    state.streamUrl,
    { onEvent: handleEvent }
  );

  // Polling fallback - check sandbox status periodically when SSE might not be working
  useEffect(() => {
    // Only poll when we have a runId and status is 'creating'
    if (!state.runId || state.status !== 'creating') {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    // Start polling after 5 seconds (give SSE time to connect)
    const startPolling = setTimeout(() => {
      pollIntervalRef.current = setInterval(async () => {
        try {
          const sandbox = await getSandbox(state.runId!);
          if (!sandbox) {
            // Sandbox was deleted/expired
            console.log('[useSandbox] Sandbox not found (deleted or expired)');
            setState((prev) => ({
              ...prev,
              status: 'deleted',
              isLaunching: false,
              logs: [...prev.logs, 'Sandbox expired or was deleted'],
            }));
            return;
          }

          if (sandbox.status === 'running' && sandbox.ingress_url) {
            console.log('[useSandbox] Polling detected sandbox is ready');
            setState((prev) => ({
              ...prev,
              status: 'running',
              ingressUrl: sandbox.ingress_url || null,
              bootstrapMs: sandbox.bootstrap_ms || null,
              restoreMs: sandbox.restore_ms || null,
              isLaunching: false,
              logs: [...prev.logs, `Game ready at: ${sandbox.ingress_url}`],
            }));
          } else if (sandbox.status === 'failed') {
            setState((prev) => ({
              ...prev,
              status: 'failed',
              isLaunching: false,
              logs: [...prev.logs, 'Sandbox creation failed'],
            }));
          }
        } catch (e) {
          console.warn('[useSandbox] Poll error:', e);
        }
      }, 3000); // Poll every 3 seconds
    }, 5000); // Wait 5 seconds before starting to poll

    return () => {
      clearTimeout(startPolling);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [state.runId, state.status]);

  // Launch sandbox
  const launch = useCallback(async (game: GameType, useSnapshot: boolean = true) => {
    const snapshotText = useSnapshot ? 'with snapshot' : 'from GitHub';
    setState({
      ...initialLaunchState,
      isLaunching: true,
      status: 'creating',
      logs: [`Launching ${type} sandbox ${snapshotText} for ${game} game...`],
    });
    setStartTime(Date.now());

    try {
      const response = await launchSandbox(type, game, useSnapshot);
      // Construct full SSE URL (SSE must bypass Next.js proxy)
      const fullStreamUrl = response.stream_url.startsWith('/')
        ? `${SSE_BASE}${response.stream_url}`
        : response.stream_url;
      setState((prev) => ({
        ...prev,
        runId: response.run_id,
        streamUrl: fullStreamUrl,
        logs: [...prev.logs, response.message],
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isLaunching: false,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        logs: [...prev.logs, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`],
      }));
    }
  }, [type]);

  // Delete sandbox
  const remove = useCallback(async () => {
    if (!state.runId) return;

    try {
      await deleteSandbox(state.runId);
      disconnect();
      setState(initialLaunchState);
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to delete',
      }));
    }
  }, [state.runId, disconnect]);

  // Reset state
  const reset = useCallback(() => {
    disconnect();
    setState(initialLaunchState);
    setStartTime(null);
  }, [disconnect]);

  return {
    ...state,
    connected,
    launch,
    remove,
    reset,
    updateElapsed,
  };
}

export function useGlobalStatus() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getStatus();
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, []);

  return { status, loading, error, refresh };
}
