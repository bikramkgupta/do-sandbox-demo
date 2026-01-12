import { LaunchResponse, StatusResponse, GameType, SandboxType } from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

export async function launchSandbox(
  type: SandboxType,
  game: GameType,
  useSnapshot: boolean = true
): Promise<LaunchResponse> {
  const response = await fetch(`${API_BASE}/api/launch/${type}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ game, use_snapshot: useSnapshot }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to launch sandbox');
  }

  return response.json();
}

export async function deleteSandbox(runId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/sandbox/${runId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to delete sandbox');
  }
}

export async function getSandbox(runId: string): Promise<{
  run_id: string;
  type: string;
  game: string;
  status: string;
  app_id?: string;
  ingress_url?: string;
  bootstrap_ms?: number;
  restore_ms?: number;
  duration_ms?: number;
  created_at: string;
  expires_at?: string;
} | null> {
  const response = await fetch(`${API_BASE}/api/sandbox/${runId}`);

  if (response.status === 404) {
    return null; // Sandbox not found (deleted or expired)
  }

  if (!response.ok) {
    throw new Error('Failed to get sandbox');
  }

  return response.json();
}

export async function getStatus(): Promise<StatusResponse> {
  const response = await fetch(`${API_BASE}/api/status`);

  if (!response.ok) {
    throw new Error('Failed to get status');
  }

  return response.json();
}

export async function getLimits(): Promise<{
  active: { cold: number; warm: number; snapshot: number; total: number };
  rate: { used: number; limit: number; reset_in_seconds: number };
  limits: { max_cold: number; max_warm: number; max_total: number; max_per_hour: number };
}> {
  const response = await fetch(`${API_BASE}/api/limits`);

  if (!response.ok) {
    throw new Error('Failed to get limits');
  }

  return response.json();
}

export function createEventSource(runId: string): EventSource {
  return new EventSource(`${API_BASE}/api/stream/${runId}`);
}

export interface OrchestratorLog {
  timestamp: string;
  level: string;
  message: string;
}

export async function getOrchestratorLogs(limit: number = 50): Promise<{
  logs: OrchestratorLog[];
  count: number;
}> {
  const response = await fetch(`${API_BASE}/api/orchestrator/logs?limit=${limit}`);
  if (!response.ok) {
    throw new Error('Failed to fetch orchestrator logs');
  }
  return response.json();
}

export async function getPoolStatus(): Promise<{
  ready: number;
  creating: number;
  in_use: number;
  pool_started: boolean;
  python?: { ready: number; creating: number };
  node?: { ready: number; creating: number };
}> {
  const response = await fetch(`${API_BASE}/api/pool/status`);
  if (!response.ok) {
    throw new Error('Failed to fetch pool status');
  }
  return response.json();
}
