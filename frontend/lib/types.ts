export type SandboxType = 'cold' | 'warm';
export type GameType = 'snake' | 'tic-tac-toe' | 'memory';
export type SandboxStatus = 'creating' | 'running' | 'completed' | 'failed';

export interface LaunchRequest {
  game: GameType;
  use_snapshot: boolean;
}

export interface LaunchResponse {
  run_id: string;
  stream_url: string;
  message: string;
}

export interface SandboxInfo {
  run_id: string;
  type: SandboxType;
  game: GameType;
  status: SandboxStatus;
  app_id?: string;
  ingress_url?: string;
  bootstrap_ms?: number;
  acquire_ms?: number;
  restore_ms?: number;
  duration_ms?: number;
  created_at: string;
  expires_at?: string;
}

export interface PoolStatus {
  ready: number;
  creating: number;
  in_use: number;
}

export interface RateStatus {
  used: number;
  limit: number;
  reset_in_seconds: number;
}

export interface ActiveCounts {
  cold: number;
  warm: number;
  snapshot: number;
  total: number;
}

export interface StatusResponse {
  active: SandboxInfo[];
  active_counts: ActiveCounts;
  pool: PoolStatus;
  rate: RateStatus;
}

export interface LogEvent {
  type: 'log';
  run_id: string;
  message: string;
  timestamp: string;
}

export interface StatusEvent {
  type: 'status';
  run_id: string;
  status: SandboxStatus;
  timestamp: string;
}

export interface ReadyEvent {
  type: 'ready';
  run_id: string;
  ingress_url: string;
  bootstrap_ms: number;
  timestamp: string;
}

export type SSEEvent = LogEvent | StatusEvent | ReadyEvent | { type: 'keepalive' };
