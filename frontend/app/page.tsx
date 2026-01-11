'use client';

import { useState, useEffect, useCallback } from 'react';
import { Turtle, Zap, Play, Trash2, ExternalLink, Info, Clock, Package } from 'lucide-react';
import { useSandbox, useGlobalStatus } from '@/hooks/use-sandbox';
import { GameType, SandboxType } from '@/lib/types';

const GAMES: { value: GameType; label: string; emoji: string }[] = [
  { value: 'snake', label: 'Snake', emoji: '🐍' },
  { value: 'tic-tac-toe', label: 'Tic-Tac-Toe', emoji: '⭕' },
  { value: 'memory', label: 'Memory', emoji: '🧠' },
];

function LaunchCard({
  type,
  title,
  subtitle,
  timing,
  icon: Icon,
  iconColor,
}: {
  type: SandboxType;
  title: string;
  subtitle: string;
  timing: string;
  icon: React.ElementType;
  iconColor: string;
}) {
  const sandbox = useSandbox(type);
  const [selectedGame, setSelectedGame] = useState<GameType>('snake');
  const [useSnapshot, setUseSnapshot] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  // Timer for elapsed time while creating
  useEffect(() => {
    if (sandbox.status !== 'creating') {
      return;
    }
    const interval = setInterval(() => {
      setElapsed((prev) => prev + 100);
    }, 100);
    return () => clearInterval(interval);
  }, [sandbox.status]);

  // Reset elapsed when launching
  useEffect(() => {
    if (sandbox.status === 'creating') {
      setElapsed(0);
    }
  }, [sandbox.status]);

  const displayTime = sandbox.elapsedMs || elapsed;
  const isRunning = sandbox.status === 'running';
  const isCreating = sandbox.status === 'creating' || sandbox.isLaunching;
  const isFailed = sandbox.status === 'failed';

  const handleLaunch = useCallback(() => {
    sandbox.launch(selectedGame, useSnapshot);
  }, [sandbox, selectedGame, useSnapshot]);

  return (
    <div className="bg-do-dark rounded-xl p-6 border border-gray-800 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className={`p-2 rounded-lg ${iconColor}`}>
          <Icon className="w-6 h-6" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <p className="text-sm text-gray-400">{subtitle}</p>
        </div>
      </div>

      {/* Timing badge */}
      <div className="text-center mb-4">
        <span className="text-2xl font-mono font-bold text-do-blue">{timing}</span>
        <p className="text-xs text-gray-500 mt-1">to acquire sandbox</p>
      </div>

      {/* Game selector */}
      <div className="mb-4">
        <p className="text-sm text-gray-400 mb-2">Select game:</p>
        <div className="space-y-2">
          {GAMES.map((game) => (
            <label
              key={game.value}
              className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition ${
                selectedGame === game.value
                  ? 'bg-do-blue/20 border border-do-blue'
                  : 'bg-do-darker border border-transparent hover:border-gray-700'
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
      </div>

      {/* Snapshot toggle */}
      <div className="mb-4 p-3 bg-do-darker rounded-lg border border-gray-700">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={useSnapshot}
            onChange={(e) => setUseSnapshot(e.target.checked)}
            disabled={isCreating || isRunning}
            className="w-5 h-5 rounded border-gray-600 bg-do-dark text-do-blue focus:ring-do-blue"
          />
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-purple-400" />
            <span className="text-sm text-white">Use Snapshot</span>
          </div>
        </label>
        <p className="text-xs text-gray-500 mt-2 ml-8">
          {useSnapshot
            ? 'Restore pre-built app (~10s)'
            : 'Clone from GitHub + install deps (~60s)'}
        </p>
      </div>

      {/* Status / Progress */}
      <div className="bg-do-darker rounded-lg p-4 mb-4 min-h-[120px]">
        {sandbox.status === 'idle' && (
          <div className="text-center">
            <p className="text-gray-500">Ready to launch</p>
            <p className="text-xs text-gray-600 mt-2">
              {type === 'cold' && useSnapshot && '~40s total (30s sandbox + 10s restore)'}
              {type === 'cold' && !useSnapshot && '~90s total (30s sandbox + 60s build)'}
              {type === 'warm' && useSnapshot && '~10s total (50ms acquire + 10s restore)'}
              {type === 'warm' && !useSnapshot && '~60s total (50ms acquire + 60s build)'}
            </p>
          </div>
        )}

        {isCreating && (
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">
                {sandbox.logs[sandbox.logs.length - 1] || 'Starting...'}
              </span>
            </div>
            <div className="text-center">
              <span className="text-2xl font-mono text-do-blue">
                {(displayTime / 1000).toFixed(1)}s
              </span>
            </div>
            <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-do-blue animate-stripes rounded-full transition-all"
                style={{
                  width: `${Math.min(
                    (displayTime / (type === 'warm' && useSnapshot ? 15000 : 60000)) * 100,
                    95
                  )}%`,
                }}
              />
            </div>
          </div>
        )}

        {isRunning && sandbox.ingressUrl && (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-2 text-do-green">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-do-green opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-do-green"></span>
              </span>
              <span className="font-semibold">Live!</span>
            </div>
            <div className="text-center space-y-1">
              {sandbox.bootstrapMs && (
                <p className="text-xs text-gray-400">
                  {type === 'cold' ? 'Sandbox' : 'Acquire'}:{' '}
                  <span className="text-white font-mono">
                    {type === 'warm'
                      ? `${sandbox.bootstrapMs}ms`
                      : `${(sandbox.bootstrapMs / 1000).toFixed(1)}s`}
                  </span>
                </p>
              )}
              {sandbox.restoreMs && (
                <p className="text-xs text-gray-400">
                  {useSnapshot ? 'Restore' : 'Build'}:{' '}
                  <span className="text-white font-mono">
                    {(sandbox.restoreMs / 1000).toFixed(1)}s
                  </span>
                </p>
              )}
              <p className="text-sm text-do-blue font-semibold">
                Total: {((sandbox.elapsedMs || 0) / 1000).toFixed(1)}s
              </p>
            </div>
          </div>
        )}

        {isFailed && (
          <div className="text-center">
            <p className="text-do-red font-semibold">Failed</p>
            <p className="text-sm text-gray-400 mt-1">{sandbox.error}</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-auto space-y-2">
        {!isRunning && !isCreating && (
          <button
            onClick={handleLaunch}
            disabled={isCreating}
            className="w-full py-3 px-4 bg-do-blue text-white rounded-lg font-semibold flex items-center justify-center gap-2 hover:bg-blue-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {type === 'cold' ? (
              <Turtle className="w-5 h-5" />
            ) : (
              <Zap className="w-5 h-5" />
            )}
            Launch {type === 'cold' ? 'Cold' : 'Warm'}
          </button>
        )}

        {isRunning && sandbox.ingressUrl && (
          <>
            <a
              href={sandbox.ingressUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-3 px-4 bg-do-green text-do-dark rounded-lg font-semibold flex items-center justify-center gap-2 hover:bg-green-400 transition"
            >
              <ExternalLink className="w-5 h-5" />
              Play {selectedGame === 'snake' ? '🐍' : selectedGame === 'tic-tac-toe' ? '⭕' : '🧠'} Game
            </a>
            <button
              onClick={sandbox.remove}
              className="w-full py-2 px-4 bg-transparent border border-do-red text-do-red rounded-lg font-semibold flex items-center justify-center gap-2 hover:bg-do-red/20 transition"
            >
              <Trash2 className="w-4 h-4" />
              Delete Sandbox
            </button>
          </>
        )}

        {isCreating && (
          <button
            onClick={sandbox.reset}
            className="w-full py-2 px-4 bg-transparent border border-gray-600 text-gray-400 rounded-lg font-semibold flex items-center justify-center gap-2 hover:bg-gray-800 transition"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function LiveLog({ logs }: { logs: string[] }) {
  return (
    <div className="bg-do-dark rounded-xl p-4 border border-gray-800">
      <h3 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
        <Clock className="w-5 h-5 text-do-blue" />
        Live Log
      </h3>
      <div className="bg-do-darker rounded-lg p-3 h-48 overflow-y-auto font-mono text-sm">
        {logs.length === 0 ? (
          <p className="text-gray-500">No activity yet. Launch a sandbox to see logs.</p>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="text-gray-300 py-1 border-b border-gray-800 last:border-0">
              <span className="text-gray-500 mr-2">
                {new Date().toLocaleTimeString()}
              </span>
              {log}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function StatsBar({
  rate,
  active,
}: {
  rate: { used: number; limit: number; reset_in_seconds: number };
  active: { cold: number; warm: number; snapshot: number; total: number };
}) {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-do-dark rounded-xl p-4 border border-gray-800">
      <div className="flex flex-wrap justify-between items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-gray-400">Rate:</span>
          <span className={`font-mono ${rate.used >= rate.limit ? 'text-do-red' : 'text-white'}`}>
            {rate.used}/{rate.limit}
          </span>
          <span className="text-gray-500">this hour</span>
          {rate.used >= rate.limit && (
            <span className="text-do-red text-xs">
              (resets in {formatTime(rate.reset_in_seconds)})
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Turtle className="w-4 h-4 text-orange-400" />
            <span className="text-gray-400">Cold:</span>
            <span className="text-white font-mono">{active.cold}/2</span>
          </div>
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-yellow-400" />
            <span className="text-gray-400">Warm:</span>
            <span className="text-white font-mono">{active.warm}/2</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function BreakdownCard() {
  return (
    <div className="bg-do-dark rounded-xl p-4 border border-gray-800">
      <h3 className="text-sm font-semibold text-gray-400 mb-3">TIME BREAKDOWN</h3>
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-gray-500 mb-2">🐢 Cold Start</p>
          <div className="space-y-1">
            <p className="text-gray-400">
              <span className="text-do-green">+ Snapshot:</span>{' '}
              <span className="text-white">~40s</span>
              <span className="text-gray-600 text-xs ml-1">(30s + 10s)</span>
            </p>
            <p className="text-gray-400">
              <span className="text-do-red">- Snapshot:</span>{' '}
              <span className="text-white">~90s</span>
              <span className="text-gray-600 text-xs ml-1">(30s + 60s)</span>
            </p>
          </div>
        </div>
        <div>
          <p className="text-gray-500 mb-2">⚡ Warm Pool</p>
          <div className="space-y-1">
            <p className="text-gray-400">
              <span className="text-do-green">+ Snapshot:</span>{' '}
              <span className="text-white">~10s</span>
              <span className="text-gray-600 text-xs ml-1">(50ms + 10s)</span>
            </p>
            <p className="text-gray-400">
              <span className="text-do-red">- Snapshot:</span>{' '}
              <span className="text-white">~60s</span>
              <span className="text-gray-600 text-xs ml-1">(50ms + 60s)</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const { status, refresh } = useGlobalStatus();

  // Refresh status periodically
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <main className="min-h-screen p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">
          <span className="text-do-blue">DO</span> App Sandbox Demo
        </h1>
        <p className="text-gray-400 text-lg">
          Experience the speed difference: Cold Start vs Warm Pool
        </p>
      </div>

      {/* Stats bar */}
      {status && (
        <div className="mb-6">
          <StatsBar rate={status.rate} active={status.active_counts} />
        </div>
      )}

      {/* Comparison panel - 2 columns */}
      <div className="mb-6">
        <div className="text-center mb-4">
          <h2 className="text-xl font-semibold text-white">
            🚀 EXPERIENCE THE SPEED DIFFERENCE
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <LaunchCard
            type="cold"
            title="🐢 COLD START"
            subtitle="Fresh sandbox provisioning"
            timing="~30 seconds"
            icon={Turtle}
            iconColor="bg-orange-500/20 text-orange-400"
          />
          <LaunchCard
            type="warm"
            title="⚡ WARM POOL"
            subtitle="Pre-warmed sandbox"
            timing="~50ms"
            icon={Zap}
            iconColor="bg-yellow-500/20 text-yellow-400"
          />
        </div>
      </div>

      {/* Time breakdown */}
      <div className="mb-6">
        <BreakdownCard />
      </div>

      {/* Active sandboxes */}
      {status && status.active.length > 0 && (
        <div className="mb-6">
          <div className="bg-do-dark rounded-xl p-4 border border-gray-800">
            <h3 className="text-lg font-semibold text-white mb-3">
              Active Sandboxes ({status.active.length}/6)
            </h3>
            <div className="space-y-2">
              {status.active.map((sandbox) => (
                <div
                  key={sandbox.run_id}
                  className="flex items-center justify-between bg-do-darker p-3 rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">
                      {sandbox.type === 'cold' ? '🐢' : '⚡'}
                    </span>
                    <span className="text-white font-mono text-sm">
                      {sandbox.run_id.slice(0, 8)}
                    </span>
                    <span className="text-gray-400 text-sm">
                      {sandbox.game}
                    </span>
                    <span className={`text-xs px-2 py-1 rounded ${
                      sandbox.status === 'running' ? 'bg-do-green/20 text-do-green' :
                      sandbox.status === 'creating' ? 'bg-do-blue/20 text-do-blue' :
                      'bg-do-red/20 text-do-red'
                    }`}>
                      {sandbox.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {sandbox.ingress_url && (
                      <a
                        href={sandbox.ingress_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 text-do-blue hover:bg-do-blue/20 rounded-lg transition"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Footer info */}
      <div className="text-center text-gray-500 text-sm mt-8">
        <p className="flex items-center justify-center gap-2">
          <Info className="w-4 h-4" />
          Sandboxes auto-delete after 3-6 minutes. Max 10 launches per hour.
        </p>
        <p className="mt-2 text-xs">
          Games from{' '}
          <a
            href="https://github.com/bikramkgupta/do-sandbox-games"
            target="_blank"
            rel="noopener noreferrer"
            className="text-do-blue hover:underline"
          >
            github.com/bikramkgupta/do-sandbox-games
          </a>
        </p>
      </div>
    </main>
  );
}
