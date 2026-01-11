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
