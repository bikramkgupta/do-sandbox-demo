# Orchestrator Demo - Critical Issues Task List

## Overview

This document captures critical issues that need to be fixed in the Orchestrator demo application.

**App URL:** https://orchestrator-demo-3cu9r.ondigitalocean.app/
**App ID:** 93325ad4-ec00-4211-862c-23489ec3e32c

---

## Getting Started (Clean Session)

### 1. Clean Up First

```bash
# Delete ALL sandbox apps to start fresh
doctl apps list --format ID,Spec.Name | grep sandbox | awk '{print $1}' | xargs -I {} doctl apps delete {} --force

# Verify no sandboxes remain
doctl apps list | grep sandbox
# Should show nothing
```

### 2. Force Redeploy Orchestrator

```bash
# This restarts the backend and triggers fresh pool initialization
doctl apps create-deployment 93325ad4-ec00-4211-862c-23489ec3e32c
```

### 3. Monitor for 5 Minutes

```bash
# Watch sandbox creation with NO user interaction
watch -n 10 'echo "=== Sandbox Apps ===" && doctl apps list --format Spec.Name,ActiveDeployment.Phase | grep sandbox && echo "" && echo "=== Pool Status ===" && curl -s https://orchestrator-demo-3cu9r.ondigitalocean.app/api/pool/status'
```

**Expected:** 2-3 sandboxes total (target_ready=2 for Python + 1 for Node = 3)
**If you see 5+ sandboxes:** There's a churn/leak issue

### 4. Test the Games

```bash
# Test Snake (Python) - should work
curl -X POST "https://orchestrator-demo-3cu9r.ondigitalocean.app/api/launch/warm" \
  -H "Content-Type: application/json" \
  -d '{"game": "snake", "use_snapshot": true}'

# Test Memory (Python) - should work
curl -X POST "https://orchestrator-demo-3cu9r.ondigitalocean.app/api/launch/warm" \
  -H "Content-Type: application/json" \
  -d '{"game": "memory", "use_snapshot": true}'

# Test Tic-Tac-Toe (Node) - may cold-start since Node pool has issues
curl -X POST "https://orchestrator-demo-3cu9r.ondigitalocean.app/api/launch/cold" \
  -H "Content-Type: application/json" \
  -d '{"game": "tic-tac-toe", "use_snapshot": true}'
```

---

## Issue 1: Warm Pool Over-Provisioning / Sandbox Churn (CRITICAL)

### Problem Statement

The warm pool is creating sandboxes constantly even when there is **zero user demand**. Screenshots show:
- 9-10 sandbox apps in DigitalOcean
- Sandboxes constantly in "Creating..." state (deployed less than 20 seconds ago)
- New sandboxes appearing every few seconds

**Expected behavior:** Pool should maintain `target_ready=2` sandboxes for Python (and 1 for Node = 3 total). These should sit idle until needed, not churn constantly.

**Actual behavior:** Constant sandbox creation/destruction cycle resulting in 9+ apps when only 3 should exist.

### Evidence

```bash
$ doctl apps list | grep sandbox | wc -l
9
```

Screenshot shows constant churn:
- sandbox-2cb2f325: "Creating..." (deployed less than 20 seconds ago)
- sandbox-651171a9: "Creating..." (deployed less than 20 seconds ago)
- sandbox-43cf814c: "Healthy" (deployed less than a minute ago)
- sandbox-aed9ef9c: "Healthy" (deployed less than a minute ago)

### Root Cause Analysis - Three Hypotheses

#### Hypothesis A: Sandbox Lifetime Conflict (Most Likely)

**Two systems managing sandbox lifetime:**

1. **SDK Pool Management:**
   - `max_warm_age=1800` (30 min) - cycle sandboxes after 30 min
   - `idle_timeout=120` (2 min) - scale down after no acquires

2. **Orchestrator Cleanup Task:**
   - `SANDBOX_MIN_LIFETIME_MINUTES=3` / `SANDBOX_MAX_LIFETIME_MINUTES=6`
   - Cleanup runs every 30 seconds
   - Deletes sandboxes where `expires_at <= now`

**POTENTIAL BUG:** When a user acquires a warm sandbox:
1. SDK gives sandbox to user (removes from pool)
2. Orchestrator sets `expires_at = now + 3-6 minutes`
3. After 3-6 min, orchestrator calls `sandbox.delete()`
4. SDK sees pool below target_ready, creates replacement
5. Churn cycle begins

**BUT** this only explains churn for USER-LAUNCHED sandboxes. The screenshot shows churn with NO user activity.

#### Hypothesis B: Sandbox Creation Failures

If sandbox creation is failing or timing out:
1. SDK attempts to create sandbox
2. DO App is created but sandbox doesn't become ready
3. SDK times out (create_retries=2, create_retry_delay=10)
4. Orphaned DO app left behind
5. SDK tries again, more orphans accumulate

This would explain 9 apps when target is only 3.

**Evidence needed:** Check DO app status - are any stuck in non-healthy state?

#### Hypothesis C: SDK Bug

The do-app-sandbox SDK's SandboxManager may have a bug:
- Not properly tracking sandboxes it creates
- Creating more than target_ready
- Not respecting max_concurrent_creates limit

**Investigation needed:** Add verbose logging to SDK interactions, or test SDK in isolation.

### Current Configuration

```python
# Pool Config (cold_service.py)
"python": PoolConfig(
    target_ready=2,           # Want 2 ready
    max_ready=10,             # Allow up to 10
    idle_timeout=120,         # Scale down after 2 min idle
    max_warm_age=1800,        # Cycle after 30 min
    max_concurrent_creates=2,  # Max 2 creating at once
)
"node": PoolConfig(
    target_ready=1,
    max_ready=3,
    ...
)
max_total_sandboxes=13  # Global limit
```

```python
# Orchestrator Cleanup (config.py)
SANDBOX_MIN_LIFETIME_MINUTES=3
SANDBOX_MAX_LIFETIME_MINUTES=6
CLEANUP_INTERVAL_SECONDS=30
```

### Investigation Steps

1. **Monitor DO apps over 5 minutes with NO user interaction:**
   ```bash
   watch -n 10 'doctl apps list --format Spec.Name,ActiveDeployment.Phase | grep sandbox'
   ```

2. **Check if sandboxes are failing creation:**
   ```bash
   doctl apps list --format Spec.Name,ID | grep sandbox | while read name id; do
     echo "=== $name ==="
     doctl apps get $id --format ActiveDeployment.Phase
   done
   ```

3. **Check orchestrator logs for errors:**
   ```bash
   curl -s "https://orchestrator-demo-3cu9r.ondigitalocean.app/api/orchestrator/logs?limit=50"
   ```

4. **Check pool status API:**
   ```bash
   curl -s "https://orchestrator-demo-3cu9r.ondigitalocean.app/api/pool/status"
   ```

### Fix Plan

1. **Add verbose logging** - Log every sandbox create/delete with app_id
2. **Reduce limits significantly:**
   - `target_ready=1` (not 2)
   - `max_ready=2` (not 10)
   - `max_total_sandboxes=3` (not 13)
3. **Ensure cleanup only affects user-launched sandboxes** - Verify pool sandboxes aren't being cleaned up
4. **Consider disabling warm_up() temporarily** - Let pool scale up on-demand only
5. **Add reconciliation** - Periodically check DO apps vs tracked sandboxes

### Files to Modify

- `backend/services/cold_service.py` - Pool config, add logging
- `backend/config.py` - Reduce default limits
- `.do/app.yaml` - Update environment variables

---

## Issue 2: Simplify to Single Pool (Python Only)

### Problem Statement

The current configuration has TWO pools:
- Python pool (for Snake, Memory games) - `target_ready=2`
- Node pool (for Tic-Tac-Toe game) - `target_ready=1`

This adds complexity and the Node pool has issues (observed 0 ready sandboxes).

### Game Runtime Analysis

| Game | Runtime | Image | Snapshot ID |
|------|---------|-------|-------------|
| Snake | Python | `python` | `snake-python` |
| Memory | Python | `python` | `memory-python` |
| Tic-Tac-Toe | Node.js | `node` | `tictactoe-node` |

**2 out of 3 games use Python.**

### Recommendation: Single Python Pool

For this demo, simplify to ONE pool:

1. **Keep Python pool only** with `target_ready=2`
2. **Tic-Tac-Toe will cold-start** (no warm pool for Node) - this is fine for demo purposes
3. Reduces complexity and debugging surface area
4. Snake and Memory (both Python) will be instant from warm pool

**Note:** We're NOT removing Tic-Tac-Toe from the UI. Users can still play it, it will just take ~30s cold start instead of instant.

### Fix Plan

1. Remove `"node": PoolConfig(...)` from `cold_service.py`
2. Update `max_total_sandboxes` to be smaller (e.g., 3 instead of 13)
3. Keep Tic-Tac-Toe in UI but it will gracefully fall back to cold start

### Files to Modify

- `backend/services/cold_service.py` - Remove Node pool config

---

## Issue 3: SSE Log Streaming Not Working

### Problem Statement

When a user clicks "Launch Warm", the expanded panel shows:
```
Waiting for orchestrator events...
```

Instead of streaming the actual deployment logs like:
- "Acquiring sandbox from warm pool..."
- "Pool acquisition: 582ms (pool hit)"
- "Deploying snake from snapshot..."
- "Game ready!"

The main orchestrator log pane (at top) DOES show logs. But the per-launch SSE stream is broken.

### Evidence

Testing SSE endpoint directly returns nothing:
```bash
$ curl -m 5 "https://orchestrator-demo-3cu9r.ondigitalocean.app/api/stream/{run_id}"
# Times out with 0 bytes received - no HTTP headers even
```

### Root Cause Analysis

**Location:** `backend/main.py` lines 215-229 and `backend/services/cold_service.py` lines 629-660

The `stream_events()` async generator has replay logic:
```python
# First, replay any buffered logs that were emitted before SSE connected
if runtime and runtime.logs:
    for log_message in runtime.logs:
        yield LogEvent(run_id=run_id, message=log_message)
```

But the SSE connection appears to hang. Possible causes:

1. **App Platform routing issue** - Long-lived SSE connections may not work properly through DO App Platform's HTTP/2 routing
2. **EventSourceResponse configuration** - May need specific headers for App Platform
3. **Race condition** - Warm pool is so fast (~500ms) that events finish before SSE connects, and replay isn't working

### Debugging Steps

1. Test SSE locally (bypass App Platform routing)
2. Add explicit flush/ping to SSE stream
3. Check if `sse-starlette` library needs specific configuration
4. Consider using polling instead of SSE for reliability

### Files to Modify

- `backend/main.py` - SSE endpoint configuration
- `backend/services/cold_service.py` - stream_events() implementation
- `frontend/hooks/use-sse.ts` - SSE client handling
- `frontend/hooks/use-sandbox.ts` - Event handling

---

## Issue 4: Tic-Tac-Toe and Memory Games Not Working

### Problem Statement

Only Snake game has been tested. Tic-Tac-Toe and Memory games need verification.

### Verification Steps

1. **Manual test each game via cold start:**
   ```bash
   # Launch Tic-Tac-Toe (Node)
   curl -X POST "https://orchestrator-demo-3cu9r.ondigitalocean.app/api/launch/cold" \
     -H "Content-Type: application/json" \
     -d '{"game": "tic-tac-toe", "use_snapshot": true}'

   # Launch Memory (Python)
   curl -X POST "https://orchestrator-demo-3cu9r.ondigitalocean.app/api/launch/cold" \
     -H "Content-Type: application/json" \
     -d '{"game": "memory", "use_snapshot": true}'
   ```

2. **Check game URLs work:**
   - Get the `ingress_url` from status endpoint
   - Verify game loads in browser

3. **Check snapshot restoration:**
   - Verify snapshots exist in Spaces bucket for all games
   - Check snapshot download/extract works

### Potential Issues

1. **Snapshot not found** - Game falls back to git clone (slower)
2. **Port conflict** - All games configured for port 5000, should be fine
3. **Dependencies not installed** - Check install commands work

### Files to Check

- Games repo: `https://github.com/bikramkgupta/do-sandbox-games`
- Snapshot bucket: Check Spaces for `snake-python.tar.gz`, `tictactoe-node.tar.gz`, `memory-python.tar.gz`

---

## Issue 5: Determine SDK Bug vs Orchestrator Bug

### The Core Question

Is the sandbox churn caused by:
- **A) do-app-sandbox SDK bug** - SDK's SandboxManager isn't working correctly
- **B) Orchestrator misconfiguration** - Our code is misconfiguring or misusing the SDK

### SDK Documentation Reference

According to `https://github.com/bikramkgupta/do-app-sandbox/blob/main/docs/sandbox_manager.md`:

```
Pool behavior:
- Starts idle (0 warm) unless warm_up() is called
- Scales to target_ready on first acquire, then maintains that level
- Scales down after idle_timeout of no acquires
```

Key parameters:
- `target_ready` - Desired count when pool is active
- `max_ready` - Hard ceiling
- `idle_timeout` - Seconds before scale-down begins
- `scale_down_delay` - Seconds between destroying sandboxes during scale-down

### Investigation: Test SDK in Isolation

To determine if this is an SDK bug, create a minimal test script that uses SandboxManager WITHOUT the orchestrator:

```python
# test_sdk_pool.py
import asyncio
from do_app_sandbox import SandboxManager, PoolConfig, SandboxMode
import os

async def test_pool():
    manager = SandboxManager(
        pools={
            "python": PoolConfig(
                target_ready=2,
                max_ready=3,
                idle_timeout=60,  # 1 minute
                scale_down_delay=30,
            ),
        },
        max_total_sandboxes=5,
        max_concurrent_creates=1,
        sandbox_defaults={
            "region": "syd",
            "api_token": os.environ["DIGITALOCEAN_TOKEN"],
            "mode": SandboxMode.SERVICE,
        },
    )

    await manager.start()
    print("Pool started")

    # Warm up
    await manager.warm_up(timeout=120)
    print("Warm up complete")

    # Monitor for 5 minutes without any acquires
    for i in range(30):
        metrics = manager.metrics()
        print(f"[{i*10}s] Python pool: ready={metrics['python'].ready}, creating={metrics['python'].creating}")
        await asyncio.sleep(10)

    # Check DO apps
    print("\nNow check: doctl apps list | grep sandbox")
    print("Expected: Only 2 sandbox apps (target_ready=2)")

    await manager.shutdown()

asyncio.run(test_pool())
```

**If test shows 2 sandboxes stable for 5 minutes:** SDK is fine, bug is in orchestrator
**If test shows sandbox churn:** SDK has a bug, report to SDK maintainer

### Recommended Workflow

1. **Delete all sandbox apps first:**
   ```bash
   doctl apps list --format ID,Spec.Name | grep sandbox | awk '{print $1}' | xargs -I {} doctl apps delete {} --force
   ```

2. **Run SDK isolation test** (above)

3. **Based on results, either:**
   - Fix orchestrator code (if SDK is fine)
   - Report SDK bug (if SDK is broken)

---

## Priority Order

1. **Issue 5 (SDK vs Orchestrator)** - FIRST - Need to identify root cause before fixing
2. **Issue 1 (Warm Pool Churn)** - CRITICAL - Fix once root cause is known
3. **Issue 2 (Single Pool)** - HIGH - Simplifies everything
4. **Issue 4 (Games)** - MEDIUM - Need working demo games
5. **Issue 3 (SSE)** - LOW - Nice to have but not blocking (main orchestrator logs work)

---

## Quick Reference: Current Configuration

### Environment Variables (app.yaml)

```yaml
WARM_POOL_ENABLED: "true"
WARM_POOL_TARGET_READY: "2"
WARM_POOL_MAX_READY: "10"
WARM_POOL_IDLE_TIMEOUT: "120"
WARM_POOL_MAX_CONCURRENT_CREATES: "2"
MAX_RUNS_PER_HOUR: "25"
```

### Pool Config (cold_service.py)

```python
"python": PoolConfig(
    target_ready=target_ready,  # 2
    max_ready=max_ready,        # 10
    idle_timeout=idle_timeout,  # 120s
    scale_down_delay=60,
    max_warm_age=1800,
    on_empty="create",
),
"node": PoolConfig(
    target_ready=1,
    max_ready=3,
    ...
),
max_total_sandboxes=max_ready + 3,  # 13
```

---

## Cleanup Commands

Before starting fresh testing:

```bash
# Delete all sandbox apps
doctl apps list --format ID,Spec.Name | grep sandbox | awk '{print $1}' | xargs -I {} doctl apps delete {} --force

# Verify cleanup
doctl apps list | grep sandbox

# Redeploy orchestrator (after code fixes)
doctl apps create-deployment 93325ad4-ec00-4211-862c-23489ec3e32c
```

---

## Success Criteria

1. **Warm pool starts idle (0 sandboxes)** until first user request
2. **Pool maintains target_ready=1** after first acquire, scales down after idle_timeout
3. **No orphaned sandboxes** - All sandboxes tracked and cleaned up properly
4. **All 3 games work** - Snake, Memory, Tic-Tac-Toe load and are playable
5. **SSE logs stream** (nice to have) - Or at least main orchestrator logs work

---

## Key Files

| File | Purpose |
|------|---------|
| `backend/services/cold_service.py` | Pool manager config, sandbox lifecycle |
| `backend/config.py` | Environment variable defaults |
| `backend/main.py` | API endpoints, SSE streaming |
| `.do/app.yaml` | App Platform deployment config |
| `frontend/app/page.tsx` | Main UI, game selection |
| `frontend/hooks/use-sse.ts` | SSE client |
