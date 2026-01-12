'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Turtle,
  Zap,
  Play,
  Trash2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Terminal,
  Activity,
  Clock,
  Database,
  Package,
  RefreshCw,
} from 'lucide-react';
import { useSandbox, useGlobalStatus } from '@/hooks/use-sandbox';
import { getOrchestratorLogs, getPoolStatus, OrchestratorLog } from '@/lib/api';
import { GameType, SandboxType } from '@/lib/types';

const GAMES: { value: GameType; label: string; emoji: string }[] = [
  { value: 'snake', label: 'Snake', emoji: '🐍' },
  { value: 'tic-tac-toe', label: 'Tic-Tac-Toe', emoji: '⭕' },
  { value: 'memory', label: 'Memory', emoji: '🧠' },
];

// Orchestrator Logs Pane (collapsible, default expanded)
function OrchestratorLogsPane() {
  const [isExpanded, setIsExpanded] = useState(true);
  const [logs, setLogs] = useState<OrchestratorLog[]>([]);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledRef = useRef(false);
  const prevLogCountRef = useRef(0);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const data = await getOrchestratorLogs(50);
        setLogs(data.logs);
      } catch (e) {
        // Silently fail - logs are optional
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, []);

  // Track if user has scrolled away from bottom
  const handleScroll = useCallback(() => {
    const container = logsContainerRef.current;
    if (!container) return;

    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    isUserScrolledRef.current = !isAtBottom;
  }, []);

  // Only auto-scroll if user hasn't scrolled away and there are new logs
  useEffect(() => {
    const container = logsContainerRef.current;
    if (!isExpanded || !container) return;

    const hasNewLogs = logs.length > prevLogCountRef.current;
    prevLogCountRef.current = logs.length;

    if (hasNewLogs && !isUserScrolledRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [logs, isExpanded]);

  const getLogClass = (level: string) => {
    switch (level) {
      case 'error': return 'log-error text-do-red';
      case 'warning': return 'log-warning text-yellow-400';
      default: return 'log-info text-gray-300';
    }
  };

  return (
    <div className="glass rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <Terminal className="w-4 h-4 text-do-blue" />
          <span className="text-sm font-medium text-gray-300">Orchestrator Logs</span>
          {logs.length > 0 && (
            <span className="px-2 py-0.5 text-xs font-mono bg-do-blue/20 text-do-blue rounded">
              {logs.length} events
            </span>
          )}
        </div>
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-500" />
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-white/5 animate-fade-in">
          <div
            ref={logsContainerRef}
            onScroll={handleScroll}
            className="h-64 overflow-y-auto font-mono text-xs"
          >
            {logs.length === 0 ? (
              <div className="p-4 text-gray-500 text-center">
                Waiting for orchestrator events...
              </div>
            ) : (
              logs.map((log, i) => (
                <div
                  key={i}
                  className={`log-entry ${getLogClass(log.level)}`}
                >
                  <span className="text-gray-600 mr-3">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  {log.message}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Pool Status Badge
function PoolStatusBadge() {
  const [poolStatus, setPoolStatus] = useState<{
    ready: number;
    creating: number;
    pool_started: boolean;
  } | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const data = await getPoolStatus();
        setPoolStatus(data);
      } catch (e) {
        // Silently fail
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  if (!poolStatus) return null;

  const isWarming = poolStatus.creating > 0;
  const isReady = poolStatus.ready > 0;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-do-darker border border-white/5">
      <Database className="w-3.5 h-3.5 text-do-purple" />
      <span className="text-xs text-gray-400">Pool:</span>
      <span className={`text-xs font-mono font-medium ${isReady ? 'text-do-green' : isWarming ? 'text-do-blue' : 'text-gray-500'}`}>
        {poolStatus.ready}
      </span>
      <span className="text-xs text-gray-600">/</span>
      <span className="text-xs font-mono text-gray-400">2</span>
      {isWarming && (
        <span className="text-xs text-do-blue animate-pulse">
          +{poolStatus.creating}
        </span>
      )}
    </div>
  );
}

// Stats Header Bar
function StatsBar({
  rate,
  active,
}: {
  rate: { used: number; limit: number; reset_in_seconds: number };
  active: { cold: number; warm: number; total: number };
}) {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 glass rounded-lg">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-do-cyan" />
          <span className="text-xs text-gray-400">Rate:</span>
          <span className={`text-xs font-mono font-medium ${rate.used >= rate.limit ? 'text-do-red' : 'text-white'}`}>
            {rate.used}/{rate.limit}
          </span>
          {rate.used >= rate.limit && (
            <span className="text-xs text-do-red">
              ({formatTime(rate.reset_in_seconds)})
            </span>
          )}
        </div>

        <div className="h-4 w-px bg-white/10" />

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Turtle className="w-3.5 h-3.5 text-orange-400" />
            <span className="text-xs font-mono text-white">{active.cold}/2</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-yellow-400" />
            <span className="text-xs font-mono text-white">{active.warm}/2</span>
          </div>
        </div>
      </div>

      <PoolStatusBadge />
    </div>
  );
}

// Compact Launch Card
function CompactLaunchCard({
  type,
  sandbox,
  onLaunch,
}: {
  type: SandboxType;
  sandbox: ReturnType<typeof useSandbox>;
  onLaunch: (game: GameType, useSnapshot: boolean) => void;
}) {
  const [selectedGame, setSelectedGame] = useState<GameType>('snake');
  const [useSnapshot, setUseSnapshot] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  const isCold = type === 'cold';
  const isRunning = sandbox.status === 'running';
  const isCreating = sandbox.status === 'creating' || sandbox.isLaunching;
  const isFailed = sandbox.status === 'failed';
  const isDeleted = sandbox.status === 'deleted';
  const isIdle = sandbox.status === 'idle';
  const canLaunch = isIdle || isDeleted || isFailed;

  // Elapsed timer
  useEffect(() => {
    if (!isCreating) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Date.now() - start);
    }, 100);
    return () => clearInterval(interval);
  }, [isCreating]);

  const handleLaunch = () => {
    sandbox.reset();
    onLaunch(selectedGame, useSnapshot);
  };

  return (
    <div className={`glass rounded-xl p-4 ${isCreating ? 'border border-do-blue/30' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {isCold ? (
            <div className="p-2 rounded-lg bg-orange-500/20">
              <Turtle className="w-5 h-5 text-orange-400" />
            </div>
          ) : (
            <div className="p-2 rounded-lg bg-yellow-500/20">
              <Zap className="w-5 h-5 text-yellow-400" />
            </div>
          )}
          <div>
            <h3 className="text-sm font-semibold text-white">
              {isCold ? 'Cold Start' : 'Warm Pool'}
            </h3>
            <p className="text-xs text-gray-500">
              {isCold ? '~30-60s' : '~50ms'}
            </p>
          </div>
        </div>

        {isCreating && (
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-do-blue animate-spin" />
            <span className="text-sm font-mono text-do-blue">
              {(elapsed / 1000).toFixed(1)}s
            </span>
          </div>
        )}
      </div>

      {/* Game Selector + Launch */}
      <div className="flex items-center gap-3">
        <select
          value={selectedGame}
          onChange={(e) => setSelectedGame(e.target.value as GameType)}
          disabled={isCreating || isRunning}
          className="flex-1 px-3 py-2 bg-do-darker border border-white/10 rounded-lg text-sm text-white focus:border-do-blue focus:outline-none disabled:opacity-50"
        >
          {GAMES.map((game) => (
            <option key={game.value} value={game.value}>
              {game.emoji} {game.label}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={useSnapshot}
            onChange={(e) => setUseSnapshot(e.target.checked)}
            disabled={isCreating || isRunning}
            className="w-4 h-4 rounded border-gray-600 bg-do-darker text-do-blue focus:ring-do-blue/50"
          />
          <Package className="w-4 h-4 text-do-purple" />
        </label>

        <button
          onClick={handleLaunch}
          disabled={!canLaunch}
          className="px-4 py-2 bg-do-blue text-white rounded-lg font-medium text-sm hover:bg-do-blue-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <Play className="w-4 h-4" />
          Launch
        </button>
      </div>

      {/* Status Message */}
      {isCreating && (
        <div className="mt-3 text-xs text-do-blue">
          Creating sandbox... Check orchestrator logs for details.
        </div>
      )}
      {isFailed && (
        <div className="mt-3 text-xs text-do-red">
          Launch failed. {sandbox.error}
        </div>
      )}
      {isDeleted && (
        <div className="mt-3 text-xs text-gray-400">
          Previous sandbox expired. Ready to launch again.
        </div>
      )}
    </div>
  );
}

// Sandbox List Item
function SandboxListItem({
  sandbox,
  isExpired,
  onDelete,
}: {
  sandbox: {
    run_id: string;
    type: string;
    game: string;
    status?: string;
    ingress_url?: string;
    bootstrap_ms?: number;
    expires_at?: string;
  };
  isExpired?: boolean;
  onDelete?: () => void;
}) {
  const game = GAMES.find((g) => g.value === sandbox.game);
  const isRunning = sandbox.status === 'running';

  return (
    <div
      className={`flex items-center justify-between p-3 rounded-lg border transition-all ${
        isExpired
          ? 'bg-do-darker/30 border-white/5 opacity-60'
          : 'bg-do-darker/50 border-white/10'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="text-lg">
          {sandbox.type === 'cold' ? '🐢' : '⚡'}
        </span>
        <span className="text-lg">{game?.emoji || '🎮'}</span>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-gray-300">
              {sandbox.run_id.slice(0, 8)}
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                isExpired
                  ? 'bg-gray-500/20 text-gray-400'
                  : isRunning
                  ? 'bg-do-green/20 text-do-green'
                  : sandbox.status === 'creating'
                  ? 'bg-do-blue/20 text-do-blue'
                  : 'bg-do-red/20 text-do-red'
              }`}
            >
              {isExpired ? 'expired' : sandbox.status || 'unknown'}
            </span>
          </div>
          {sandbox.bootstrap_ms && (
            <div className="text-xs text-gray-500">
              {(sandbox.bootstrap_ms / 1000).toFixed(1)}s bootstrap
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isRunning && sandbox.ingress_url && (
          <a
            href={sandbox.ingress_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-do-green text-do-darker rounded-lg text-xs font-medium hover:bg-do-green-dim transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Play
          </a>
        )}
        {!isExpired && onDelete && (
          <button
            onClick={onDelete}
            className="p-1.5 text-gray-500 hover:text-do-red hover:bg-do-red/10 rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// Sandbox List Section
function SandboxList({
  activeSandboxes,
  expiredSandboxes,
  onDelete,
}: {
  activeSandboxes: Array<{
    run_id: string;
    type: string;
    game: string;
    status: string;
    ingress_url?: string;
    bootstrap_ms?: number;
  }>;
  expiredSandboxes: Array<{
    run_id: string;
    type: string;
    game: string;
    bootstrap_ms?: number;
  }>;
  onDelete: (runId: string) => void;
}) {
  if (activeSandboxes.length === 0 && expiredSandboxes.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {activeSandboxes.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-do-green animate-pulse" />
            Active Sandboxes ({activeSandboxes.length})
          </h3>
          <div className="space-y-2">
            {activeSandboxes.map((sandbox) => (
              <SandboxListItem
                key={sandbox.run_id}
                sandbox={sandbox}
                onDelete={() => onDelete(sandbox.run_id)}
              />
            ))}
          </div>
        </div>
      )}

      {expiredSandboxes.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-500 mb-3">
            Recently Expired ({expiredSandboxes.length})
          </h3>
          <div className="space-y-2">
            {expiredSandboxes.map((sandbox) => (
              <SandboxListItem
                key={sandbox.run_id}
                sandbox={sandbox}
                isExpired
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const { status, refresh } = useGlobalStatus();
  const coldSandbox = useSandbox('cold');
  const warmSandbox = useSandbox('warm');
  const [expiredSandboxes, setExpiredSandboxes] = useState<Array<{
    run_id: string;
    type: string;
    game: string;
    bootstrap_ms?: number;
  }>>([]);

  // Refresh status periodically
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Track when sandboxes expire
  useEffect(() => {
    const runId = coldSandbox.runId;
    if (coldSandbox.status === 'deleted' && runId) {
      setExpiredSandboxes((prev) => {
        // Avoid duplicates
        if (prev.some((s) => s.run_id === runId)) return prev;
        return [
          {
            run_id: runId,
            type: 'cold',
            game: 'snake', // TODO: track actual game
            bootstrap_ms: coldSandbox.bootstrapMs || undefined,
          },
          ...prev,
        ].slice(0, 5); // Keep last 5
      });
    }
  }, [coldSandbox.status, coldSandbox.runId, coldSandbox.bootstrapMs]);

  useEffect(() => {
    const runId = warmSandbox.runId;
    if (warmSandbox.status === 'deleted' && runId) {
      setExpiredSandboxes((prev) => {
        if (prev.some((s) => s.run_id === runId)) return prev;
        return [
          {
            run_id: runId,
            type: 'warm',
            game: 'snake',
            bootstrap_ms: warmSandbox.bootstrapMs || undefined,
          },
          ...prev,
        ].slice(0, 5);
      });
    }
  }, [warmSandbox.status, warmSandbox.runId, warmSandbox.bootstrapMs]);

  const handleDelete = async (runId: string) => {
    try {
      const { deleteSandbox } = await import('@/lib/api');
      await deleteSandbox(runId);
      refresh();
    } catch (e) {
      console.error('Failed to delete sandbox:', e);
    }
  };

  return (
    <main className="min-h-screen grid-pattern noise-overlay">
      <div className="max-w-4xl mx-auto p-6">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">
            Orchestrator
          </h1>
          <p className="text-gray-400 text-lg">
            Run every agent session in its own sandbox
          </p>
        </div>

        {/* Stats Bar */}
        {status && (
          <div className="mb-6">
            <StatsBar rate={status.rate} active={status.active_counts} />
          </div>
        )}

        {/* Orchestrator Logs */}
        <div className="mb-6">
          <OrchestratorLogsPane />
        </div>

        {/* Launch Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <CompactLaunchCard
            type="cold"
            sandbox={coldSandbox}
            onLaunch={(game, useSnapshot) => coldSandbox.launch(game, useSnapshot)}
          />
          <CompactLaunchCard
            type="warm"
            sandbox={warmSandbox}
            onLaunch={(game, useSnapshot) => warmSandbox.launch(game, useSnapshot)}
          />
        </div>

        {/* Sandbox List */}
        <SandboxList
          activeSandboxes={status?.active || []}
          expiredSandboxes={expiredSandboxes}
          onDelete={handleDelete}
        />

        {/* Footer */}
        <div className="text-center text-gray-600 text-sm mt-8">
          <p>
            Sandboxes auto-delete after 3-6 minutes. Max 25 launches per hour.
          </p>
          <p className="mt-1 text-xs">
            Games from{' '}
            <a
              href="https://github.com/bikramkgupta/do-sandbox-games"
              target="_blank"
              rel="noopener noreferrer"
              className="text-do-blue hover:underline"
            >
              do-sandbox-games
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
