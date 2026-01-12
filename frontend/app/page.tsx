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
  X,
  Terminal,
  Cpu,
  Server,
  Package,
  Activity,
  Clock,
  Database,
} from 'lucide-react';
import { useSandbox, useGlobalStatus } from '@/hooks/use-sandbox';
import { getOrchestratorLogs, getPoolStatus, OrchestratorLog } from '@/lib/api';
import { GameType, SandboxType } from '@/lib/types';

const GAMES: { value: GameType; label: string; emoji: string }[] = [
  { value: 'snake', label: 'Snake', emoji: '🐍' },
  { value: 'tic-tac-toe', label: 'Tic-Tac-Toe', emoji: '⭕' },
  { value: 'memory', label: 'Memory', emoji: '🧠' },
];

// Orchestrator Logs Pane (collapsible)
function OrchestratorLogsPane() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [logs, setLogs] = useState<OrchestratorLog[]>([]);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledRef = useRef(false);
  const prevLogCountRef = useRef(0);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const data = await getOrchestratorLogs(30);
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

    // Auto-scroll only if user is at bottom or there are new logs
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
          <span className="text-sm font-medium text-gray-300">Orchestrator</span>
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
            className="h-48 overflow-y-auto font-mono text-xs"
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

// Compact Launch Card (for side panel when expanded)
function CompactLaunchCard({
  type,
  isActive,
  onClick,
}: {
  type: SandboxType;
  isActive: boolean;
  onClick: () => void;
}) {
  const isCold = type === 'cold';

  return (
    <button
      onClick={onClick}
      className={`w-full p-4 rounded-lg border transition-all ${
        isActive
          ? 'border-do-blue bg-do-blue/10'
          : 'border-white/5 bg-do-darker hover:border-white/10'
      }`}
    >
      <div className="flex items-center gap-3">
        {isCold ? (
          <Turtle className="w-5 h-5 text-orange-400" />
        ) : (
          <Zap className="w-5 h-5 text-yellow-400" />
        )}
        <div className="text-left">
          <div className="text-sm font-medium text-white">
            {isCold ? 'Cold Start' : 'Warm Pool'}
          </div>
          <div className="text-xs text-gray-500">
            {isCold ? '~30s' : '~50ms'}
          </div>
        </div>
      </div>
    </button>
  );
}

// Log Tab Panel
function LogTabs({
  activeTab,
  setActiveTab,
  logs,
}: {
  activeTab: 'orchestrator' | 'build' | 'runtime';
  setActiveTab: (tab: 'orchestrator' | 'build' | 'runtime') => void;
  logs: string[];
}) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const tabs = [
    { id: 'orchestrator' as const, label: 'Orchestrator', icon: Terminal },
    { id: 'build' as const, label: 'Build', icon: Package },
    { id: 'runtime' as const, label: 'Runtime', icon: Server },
  ];

  // Filter logs based on tab
  const filteredLogs = logs.filter((log) => {
    const lowerLog = log.toLowerCase();
    switch (activeTab) {
      case 'orchestrator':
        return lowerLog.includes('acquiring') || lowerLog.includes('pool') || lowerLog.includes('sandbox') || lowerLog.includes('creating') || lowerLog.includes('launching');
      case 'build':
        return lowerLog.includes('clone') || lowerLog.includes('install') || lowerLog.includes('snapshot') || lowerLog.includes('download') || lowerLog.includes('dependencies') || lowerLog.includes('extract');
      case 'runtime':
        return lowerLog.includes('starting') || lowerLog.includes('game') || lowerLog.includes('live') || lowerLog.includes('running') || lowerLog.includes('ready') || lowerLog.includes('total');
      default:
        return true;
    }
  });

  // Show all logs if none match the filter
  const displayLogs = filteredLogs.length > 0 ? filteredLogs : logs;

  return (
    <div className="flex flex-col h-full">
      {/* Tab buttons */}
      <div className="flex border-b border-white/5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
              activeTab === tab.id
                ? 'text-do-blue border-b-2 border-do-blue -mb-px'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Log content */}
      <div className="flex-1 overflow-y-auto p-4 font-mono text-xs bg-do-darkest/50 min-h-[200px]">
        {displayLogs.length === 0 ? (
          <div className="text-gray-600 text-center py-8">
            Waiting for {activeTab} events...
          </div>
        ) : (
          displayLogs.map((log, i) => (
            <div key={i} className="py-1 text-gray-300 leading-relaxed">
              <span className="text-gray-600 mr-2">{String(i + 1).padStart(2, '0')}</span>
              {log}
            </div>
          ))
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

// Expanded Launch Panel
function ExpandedLaunchPanel({
  type,
  sandbox,
  selectedGame,
  setSelectedGame,
  useSnapshot,
  setUseSnapshot,
  onClose,
  onLaunch,
}: {
  type: SandboxType;
  sandbox: ReturnType<typeof useSandbox>;
  selectedGame: GameType;
  setSelectedGame: (game: GameType) => void;
  useSnapshot: boolean;
  setUseSnapshot: (v: boolean) => void;
  onClose: () => void;
  onLaunch: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'orchestrator' | 'build' | 'runtime'>('orchestrator');
  const [elapsed, setElapsed] = useState(0);

  const isRunning = sandbox.status === 'running';
  const isCreating = sandbox.status === 'creating' || sandbox.isLaunching;
  const isFailed = sandbox.status === 'failed';
  const isDeleted = sandbox.status === 'deleted';
  const isIdle = sandbox.status === 'idle';
  const isFinished = isRunning || isFailed || isDeleted;

  // Elapsed timer - stops when sandbox is ready, failed, or deleted
  useEffect(() => {
    if (!isCreating || isFinished) return;
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Date.now() - start);
    }, 100);
    return () => clearInterval(interval);
  }, [isCreating, isFinished]);

  // Auto-switch tabs based on progress
  useEffect(() => {
    const lastLog = sandbox.logs[sandbox.logs.length - 1]?.toLowerCase() || '';
    if (lastLog.includes('clone') || lastLog.includes('snapshot') || lastLog.includes('install')) {
      setActiveTab('build');
    } else if (lastLog.includes('starting') || lastLog.includes('live') || lastLog.includes('game')) {
      setActiveTab('runtime');
    }
  }, [sandbox.logs]);

  // Escape key handler
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const isCold = type === 'cold';
  const displayElapsed = sandbox.elapsedMs || elapsed;

  return (
    <div className="h-full flex flex-col animate-slide-in">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/5">
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
            <h3 className="text-lg font-semibold text-white">
              {isCold ? 'Cold Start' : 'Warm Pool'} Launch
            </h3>
            <p className="text-xs text-gray-500">
              {isCold ? '~30s to provision' : '~50ms to acquire'}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-white/5 transition-colors"
        >
          <X className="w-5 h-5 text-gray-400" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Log Tabs */}
        <div className="flex-1 border-b border-white/5 overflow-hidden">
          <LogTabs
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            logs={sandbox.logs}
          />
        </div>

        {/* Game Ready Panel */}
        {isRunning && sandbox.ingressUrl && (
          <div className="p-4 bg-do-green/5 border-t border-do-green/20 animate-fade-in">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="status-dot active">
                  <span />
                </div>
                <span className="text-do-green font-medium">Game Ready!</span>
              </div>
              <a
                href={sandbox.ingressUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 bg-do-green text-do-darker rounded-lg font-medium hover:bg-do-green-dim transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Play {GAMES.find((g) => g.value === selectedGame)?.emoji} Game
              </a>
            </div>
          </div>
        )}

        {/* Time Breakdown */}
        <div className="p-4 bg-do-darker/50 border-t border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              {isCreating && (
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-do-blue animate-pulse" />
                  <span className="text-xl font-mono text-do-blue">
                    {(displayElapsed / 1000).toFixed(1)}s
                  </span>
                </div>
              )}

              {(isRunning || sandbox.bootstrapMs) && (
                <>
                  <div className="flex items-center gap-2">
                    <Cpu className="w-3.5 h-3.5 text-gray-500" />
                    <span className="text-xs text-gray-400">Bootstrap:</span>
                    <span className="text-xs font-mono text-white">
                      {type === 'warm' && sandbox.bootstrapMs && sandbox.bootstrapMs < 1000
                        ? `${sandbox.bootstrapMs}ms`
                        : `${((sandbox.bootstrapMs || 0) / 1000).toFixed(1)}s`}
                    </span>
                  </div>
                  {sandbox.restoreMs && (
                    <div className="flex items-center gap-2">
                      <Package className="w-3.5 h-3.5 text-gray-500" />
                      <span className="text-xs text-gray-400">Deploy:</span>
                      <span className="text-xs font-mono text-white">
                        {(sandbox.restoreMs / 1000).toFixed(1)}s
                      </span>
                    </div>
                  )}
                  {sandbox.elapsedMs && (
                    <div className="flex items-center gap-2">
                      <Clock className="w-3.5 h-3.5 text-do-green" />
                      <span className="text-xs text-gray-400">Total:</span>
                      <span className="text-xs font-mono text-do-green font-medium">
                        {(sandbox.elapsedMs / 1000).toFixed(1)}s
                      </span>
                    </div>
                  )}
                </>
              )}

              {isFailed && (
                <div className="flex items-center gap-2 text-do-red">
                  <span className="text-sm font-medium">Launch Failed</span>
                  <span className="text-xs text-gray-500">{sandbox.error}</span>
                </div>
              )}

              {isDeleted && (
                <div className="flex items-center gap-2 text-gray-400">
                  <span className="text-sm font-medium">Sandbox Expired</span>
                  <span className="text-xs text-gray-500">Auto-deleted after timeout</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {isRunning && (
                <button
                  onClick={sandbox.remove}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs border border-do-red/30 text-do-red rounded-lg hover:bg-do-red/10 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              )}
              {(isIdle || isDeleted || isFailed) && (
                <button
                  onClick={() => {
                    sandbox.reset();
                    onLaunch();
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-do-blue text-white rounded-lg font-medium hover:bg-do-blue-dim transition-colors"
                >
                  <Play className="w-4 h-4" />
                  {isDeleted || isFailed ? 'Launch Again' : `Launch ${isCold ? 'Cold' : 'Warm'}`}
                </button>
              )}
            </div>
          </div>

          {/* Progress bar */}
          {isCreating && !isFinished && (
            <div className="mt-3 h-1 bg-do-darker rounded-full overflow-hidden">
              <div
                className="h-full bg-do-blue animate-stripes transition-all duration-300"
                style={{
                  width: `${Math.min((displayElapsed / (type === 'warm' && useSnapshot ? 15000 : 60000)) * 100, 95)}%`,
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Main Launch Card
function LaunchCard({
  type,
  isExpanded,
  onExpand,
  sandbox,
  selectedGame,
  setSelectedGame,
  useSnapshot,
  setUseSnapshot,
  onLaunch,
}: {
  type: SandboxType;
  isExpanded: boolean;
  onExpand: () => void;
  sandbox: ReturnType<typeof useSandbox>;
  selectedGame: GameType;
  setSelectedGame: (game: GameType) => void;
  useSnapshot: boolean;
  setUseSnapshot: (v: boolean) => void;
  onLaunch: () => void;
}) {
  const isCold = type === 'cold';
  const isRunning = sandbox.status === 'running';
  const isCreating = sandbox.status === 'creating' || sandbox.isLaunching;

  const handleLaunch = useCallback(() => {
    onLaunch();
    onExpand();
  }, [onLaunch, onExpand]);

  // Auto-expand when launching
  useEffect(() => {
    if (isCreating && !isExpanded) {
      onExpand();
    }
  }, [isCreating, isExpanded, onExpand]);

  return (
    <div className="glass rounded-xl overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="p-5 border-b border-white/5">
        <div className="flex items-center gap-3">
          {isCold ? (
            <div className="p-2.5 rounded-xl bg-orange-500/20">
              <Turtle className="w-6 h-6 text-orange-400" />
            </div>
          ) : (
            <div className="p-2.5 rounded-xl bg-yellow-500/20">
              <Zap className="w-6 h-6 text-yellow-400" />
            </div>
          )}
          <div>
            <h3 className="text-lg font-semibold text-white">
              {isCold ? 'Cold Start' : 'Warm Pool'}
            </h3>
            <p className="text-sm text-gray-500">
              {isCold ? '~30s to provision' : '~50ms to acquire'}
            </p>
          </div>
        </div>
      </div>

      {/* Game Selector */}
      <div className="p-5 flex-1">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">
          Select Game
        </p>
        <div className="space-y-2">
          {GAMES.map((game) => (
            <label
              key={game.value}
              className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                selectedGame === game.value
                  ? 'bg-do-blue/10 border border-do-blue/30'
                  : 'bg-do-darker/50 border border-transparent hover:border-white/10'
              }`}
            >
              <input
                type="radio"
                name={`game-${type}`}
                value={game.value}
                checked={selectedGame === game.value}
                onChange={() => setSelectedGame(game.value)}
                className="sr-only"
                disabled={isCreating || isRunning}
              />
              <span className="text-xl">{game.emoji}</span>
              <span className="text-sm text-white">{game.label}</span>
            </label>
          ))}
        </div>

        {/* Snapshot Toggle */}
        <div className="mt-4 p-3 rounded-lg bg-do-darker/50 border border-white/5">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={useSnapshot}
              onChange={(e) => setUseSnapshot(e.target.checked)}
              disabled={isCreating || isRunning}
              className="w-4 h-4 rounded border-gray-600 bg-do-darker text-do-blue focus:ring-do-blue/50"
            />
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4 text-do-purple" />
              <span className="text-sm text-white">Use Snapshot</span>
            </div>
          </label>
          <p className="text-xs text-gray-500 mt-2 ml-7">
            {useSnapshot ? 'Restore pre-built (~10s)' : 'Clone + install (~60s)'}
          </p>
        </div>
      </div>

      {/* Launch Button */}
      <div className="p-5 pt-0">
        <button
          onClick={handleLaunch}
          disabled={isCreating || isRunning}
          className="w-full py-3.5 px-4 bg-do-blue text-white rounded-xl font-semibold flex items-center justify-center gap-2 hover:bg-do-blue-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isCold ? (
            <Turtle className="w-5 h-5" />
          ) : (
            <Zap className="w-5 h-5" />
          )}
          Launch {isCold ? 'Cold' : 'Warm'}
        </button>
      </div>
    </div>
  );
}

// Active Sandboxes List
function ActiveSandboxes({
  sandboxes,
}: {
  sandboxes: Array<{
    run_id: string;
    type: string;
    game: string;
    status: string;
    ingress_url?: string;
  }>;
}) {
  if (sandboxes.length === 0) return null;

  return (
    <div className="glass rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-400 mb-3">
        Active Sandboxes ({sandboxes.length}/6)
      </h3>
      <div className="space-y-2">
        {sandboxes.map((sandbox) => (
          <div
            key={sandbox.run_id}
            className="flex items-center justify-between p-3 rounded-lg bg-do-darker/50 border border-white/5"
          >
            <div className="flex items-center gap-3">
              <span className="text-lg">
                {sandbox.type === 'cold' ? '🐢' : '⚡'}
              </span>
              <span className="text-xs font-mono text-gray-400">
                {sandbox.run_id.slice(0, 8)}
              </span>
              <span className="text-xs text-gray-500">{sandbox.game}</span>
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  sandbox.status === 'running'
                    ? 'bg-do-green/20 text-do-green'
                    : sandbox.status === 'creating'
                    ? 'bg-do-blue/20 text-do-blue'
                    : 'bg-do-red/20 text-do-red'
                }`}
              >
                {sandbox.status}
              </span>
            </div>
            {sandbox.ingress_url && (
              <a
                href={sandbox.ingress_url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
              >
                <ExternalLink className="w-4 h-4 text-do-blue" />
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const { status, refresh } = useGlobalStatus();
  const [expandedType, setExpandedType] = useState<SandboxType | null>(null);
  const coldSandbox = useSandbox('cold');
  const warmSandbox = useSandbox('warm');
  // Separate state per sandbox type
  const [coldSelectedGame, setColdSelectedGame] = useState<GameType>('snake');
  const [coldUseSnapshot, setColdUseSnapshot] = useState(true);
  const [warmSelectedGame, setWarmSelectedGame] = useState<GameType>('snake');
  const [warmUseSnapshot, setWarmUseSnapshot] = useState(true);

  // Refresh status periodically
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleClose = useCallback(() => {
    setExpandedType(null);
  }, []);

  const currentSandbox = expandedType === 'cold' ? coldSandbox : warmSandbox;
  const selectedGame = expandedType === 'cold' ? coldSelectedGame : warmSelectedGame;
  const setSelectedGame = expandedType === 'cold' ? setColdSelectedGame : setWarmSelectedGame;
  const useSnapshot = expandedType === 'cold' ? coldUseSnapshot : warmUseSnapshot;
  const setUseSnapshot = expandedType === 'cold' ? setColdUseSnapshot : setWarmUseSnapshot;

  return (
    <main className="min-h-screen grid-pattern noise-overlay">
      <div className="max-w-7xl mx-auto p-6">
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

        {/* Main Content - Two columns or expanded view */}
        <div className="mb-6">
          {expandedType ? (
            /* Expanded View */
            <div className="flex gap-4">
              {/* Side panel - 1/4 width */}
              <div className="w-1/4 space-y-3 transition-layout">
                <CompactLaunchCard
                  type="cold"
                  isActive={expandedType === 'cold'}
                  onClick={() => setExpandedType('cold')}
                />
                <CompactLaunchCard
                  type="warm"
                  isActive={expandedType === 'warm'}
                  onClick={() => setExpandedType('warm')}
                />
              </div>

              {/* Main panel - 3/4 width */}
              <div className="w-3/4 glass rounded-xl overflow-hidden transition-layout">
                <ExpandedLaunchPanel
                  type={expandedType}
                  sandbox={currentSandbox}
                  selectedGame={selectedGame}
                  setSelectedGame={setSelectedGame}
                  useSnapshot={useSnapshot}
                  setUseSnapshot={setUseSnapshot}
                  onClose={handleClose}
                  onLaunch={() => currentSandbox.launch(selectedGame, useSnapshot)}
                />
              </div>
            </div>
          ) : (
            /* Two Column View */
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <LaunchCard
                type="cold"
                isExpanded={false}
                onExpand={() => setExpandedType('cold')}
                sandbox={coldSandbox}
                selectedGame={coldSelectedGame}
                setSelectedGame={setColdSelectedGame}
                useSnapshot={coldUseSnapshot}
                setUseSnapshot={setColdUseSnapshot}
                onLaunch={() => coldSandbox.launch(coldSelectedGame, coldUseSnapshot)}
              />
              <LaunchCard
                type="warm"
                isExpanded={false}
                onExpand={() => setExpandedType('warm')}
                sandbox={warmSandbox}
                selectedGame={warmSelectedGame}
                setSelectedGame={setWarmSelectedGame}
                useSnapshot={warmUseSnapshot}
                setUseSnapshot={setWarmUseSnapshot}
                onLaunch={() => warmSandbox.launch(warmSelectedGame, warmUseSnapshot)}
              />
            </div>
          )}
        </div>

        {/* Active Sandboxes */}
        {status && status.active.length > 0 && (
          <div className="mb-6">
            <ActiveSandboxes sandboxes={status.active} />
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-gray-600 text-sm">
          <p>
            Sandboxes auto-delete after 3-6 minutes. Max 10 launches per hour.
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
