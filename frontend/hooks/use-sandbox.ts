'use client';

import { useState, useCallback } from 'react';
import { launchSandbox, deleteSandbox, getStatus } from '@/lib/api';
import { SandboxType, GameType, SandboxInfo, StatusResponse, SSEEvent } from '@/lib/types';
import { useSSE } from './use-sse';

// SSE must connect directly to backend, not through Next.js proxy
const SSE_BASE = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_API_URL || `${window.location.protocol}//${window.location.hostname}:8000`)
  : '';

interface LaunchState {
  isLaunching: boolean;
  runId: string | null;
  streamUrl: string | null;
  error: string | null;
  status: 'idle' | 'creating' | 'running' | 'failed' | 'completed';
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
  const { connected, disconnect } = useSSE(
    state.streamUrl,
    { onEvent: handleEvent }
  );

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
