-- Initialize sandbox demo database

-- 7-day retention for sandbox history
CREATE TABLE IF NOT EXISTS sandbox_runs (
    id SERIAL PRIMARY KEY,
    run_id UUID NOT NULL UNIQUE,
    type VARCHAR(20) NOT NULL,      -- 'cold', 'warm', 'snapshot'
    image VARCHAR(20) NOT NULL,     -- 'python', 'node'
    game VARCHAR(30) NOT NULL,      -- 'snake', 'tic-tac-toe', 'memory'
    app_id VARCHAR(100),
    status VARCHAR(20) NOT NULL,    -- 'creating', 'running', 'completed', 'failed'
    bootstrap_ms INTEGER,           -- Time to create sandbox
    acquire_ms INTEGER,             -- Time to acquire (warm pool)
    restore_ms INTEGER,             -- Time to restore snapshot
    duration_ms INTEGER,            -- Total run time
    ingress_url TEXT,
    triggered_by VARCHAR(20),       -- 'user', 'scheduler'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT valid_type CHECK (type IN ('cold', 'warm', 'snapshot'))
);

-- Track currently active sandboxes
CREATE TABLE IF NOT EXISTS active_sandboxes (
    id SERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES sandbox_runs(run_id) ON DELETE CASCADE,
    app_id VARCHAR(100) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Hourly rate limiting windows
CREATE TABLE IF NOT EXISTS rate_windows (
    window_start TIMESTAMPTZ PRIMARY KEY,
    count INTEGER DEFAULT 0
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_sandbox_runs_created ON sandbox_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sandbox_runs_type ON sandbox_runs(type);
CREATE INDEX IF NOT EXISTS idx_active_sandboxes_expires ON active_sandboxes(expires_at);

-- Function to clean up old records (call daily)
CREATE OR REPLACE FUNCTION cleanup_old_records() RETURNS void AS $$
BEGIN
    DELETE FROM sandbox_runs WHERE created_at < NOW() - INTERVAL '7 days';
    DELETE FROM rate_windows WHERE window_start < NOW() - INTERVAL '2 hours';
END;
$$ LANGUAGE plpgsql;
