# Orchestrator Demo - Critical Issues Task List

## Overview

This document captures critical issues that need to be fixed in the Orchestrator demo application.

**App URL:** https://orchestrator-demo-3cu9r.ondigitalocean.app/
**App ID:** 93325ad4-ec00-4211-862c-23489ec3e32c

---

## CURRENT STATUS (2026-01-11)

### Warm Pool: DISABLED

The warm pool has been **disabled** due to a confirmed SDK bug. All games now use cold starts (~30-45s).

```yaml
# .do/app.yaml
WARM_POOL_ENABLED: "false"  # DISABLED - SDK bug causes infinite sandbox creation
```

### Root Cause: CONFIRMED SDK BUG

We isolated and confirmed that the `do-app-sandbox` SDK's `SandboxManager` has a critical bug:

1. **Does not respect `max_ready` limit** - Creates 5+ sandboxes when max_ready=3
2. **Does not properly track sandboxes** - Metrics fluctuate wildly (0 ready → 5 ready → 1 ready)
3. **Continuously creates sandboxes** - Even when above target_ready

**Evidence collected on 2026-01-11:**

```
=== Check 3 (15:05:57) ===
Pool: ready=3, creating=0  ← Good, at max_ready=3

=== Check 4 (15:06:29) ===
Pool: ready=3, creating=2  ← BUG! Creating when already at max!
DO Apps: 4 sandboxes

=== Check 5 (15:07:01) ===
Pool: ready=1, creating=1  ← Lost track of sandboxes!
DO Apps: 5 sandboxes

=== Check 6 (15:07:32) ===
Pool: ready=5, creating=1  ← ready=5 exceeds max_ready=3!
DO Apps: 6 sandboxes
```

**How we isolated the bug:**
1. Disabled orchestrator's cleanup_task (to eliminate our code as cause)
2. Observed sandbox count still growing without user requests
3. Confirmed SDK is creating sandboxes it doesn't track
4. SDK's metrics don't match actual DO apps

---

## Issue 1: SDK SandboxManager Bug (CRITICAL - BLOCKING)

### Problem Statement

The `do-app-sandbox` SDK's `SandboxManager` creates sandboxes in an infinite loop, not respecting configuration limits.

### Symptoms

- Pool creates sandboxes beyond `max_ready` limit
- `metrics()` returns inconsistent/incorrect counts
- Sandboxes created even when pool is at target
- `max_concurrent_creates` not enforced

### SDK Source Location

**Repository:** https://github.com/bikramkgupta/do-app-sandbox
**Key file:** `do_app_sandbox/sandbox_manager.py` (or similar)

### Debugging Plan

#### Step 1: Clone and Inspect SDK Source

```bash
git clone https://github.com/bikramkgupta/do-app-sandbox.git
cd do-app-sandbox

# Find the SandboxManager implementation
find . -name "*.py" -exec grep -l "SandboxManager" {} \;

# Look for pool management logic
grep -r "target_ready\|max_ready\|creating" --include="*.py"
```

#### Step 2: Add Debug Logging to SDK

Create a local copy with verbose logging:

```python
# In sandbox_manager.py, add logging to:
# - _check_pool_levels() or equivalent
# - _create_sandbox() or equivalent
# - Any background task that manages pool size

import logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("do_app_sandbox")

# Before any sandbox creation:
logger.debug(f"Pool state: ready={self.ready_count}, creating={self.creating_count}, target={self.target_ready}, max={self.max_ready}")
logger.debug(f"Decision: should_create={should_create}")
```

#### Step 3: Create Minimal Reproduction Script

```python
#!/usr/bin/env python3
"""
Minimal reproduction of SDK SandboxManager bug.
Run this OUTSIDE the orchestrator to isolate the issue.

Expected: Pool stabilizes at target_ready=2, never exceeds max_ready=3
Actual: Pool keeps creating sandboxes, exceeds limits
"""
import asyncio
import os
from datetime import datetime
from do_app_sandbox import SandboxManager, PoolConfig, SandboxMode

async def test_pool_stability():
    print(f"[{datetime.now()}] Starting SDK pool test...")

    manager = SandboxManager(
        pools={
            "python": PoolConfig(
                target_ready=2,
                max_ready=3,
                idle_timeout=600,  # 10 min - long enough to observe
                scale_down_delay=120,
                max_warm_age=3600,
                on_empty="create",
            ),
        },
        max_total_sandboxes=5,
        max_concurrent_creates=1,  # Serialize to make debugging easier
        sandbox_defaults={
            "region": "syd",
            "api_token": os.environ["DIGITALOCEAN_TOKEN"],
            "mode": SandboxMode.SERVICE,
        },
    )

    await manager.start()
    print(f"[{datetime.now()}] Pool started (not calling warm_up)")

    # Monitor for 5 minutes WITHOUT any user interaction
    print("\nMonitoring pool for 5 minutes with NO acquires...")
    print("Expected: ready count should stabilize at 0-2, never exceed 3")
    print("-" * 60)

    for i in range(30):  # 30 checks, 10s apart = 5 minutes
        metrics = manager.metrics()
        python_pool = metrics.get("python", {})

        if hasattr(python_pool, 'ready'):
            ready = python_pool.ready
            creating = python_pool.creating
        else:
            ready = python_pool.get("ready", 0)
            creating = python_pool.get("creating", 0)

        # Flag issues
        issues = []
        if ready > 3:
            issues.append(f"READY EXCEEDS MAX! ({ready} > 3)")
        if creating > 1:
            issues.append(f"CONCURRENT CREATES EXCEEDS LIMIT! ({creating} > 1)")
        if ready + creating > 5:
            issues.append(f"TOTAL EXCEEDS MAX_TOTAL! ({ready + creating} > 5)")

        issue_str = " | ".join(issues) if issues else "OK"
        print(f"[{i*10:3d}s] ready={ready}, creating={creating} | {issue_str}")

        await asyncio.sleep(10)

    print("-" * 60)
    print("\nTest complete. Now run: doctl apps list | grep sandbox")
    print("Expected: 2-3 sandbox apps")
    print("If more: SDK bug confirmed")

    print("\nShutting down pool...")
    await manager.shutdown()
    print("Done.")

if __name__ == "__main__":
    asyncio.run(test_pool_stability())
```

#### Step 4: Check These Specific Areas in SDK

1. **Background pool maintenance task:**
   - Is there a loop that runs continuously?
   - Does it correctly check current count vs target before creating?

2. **Sandbox tracking:**
   - How does SDK track sandboxes it creates?
   - Are there race conditions where a sandbox is created but not tracked?

3. **State synchronization:**
   - Does SDK track by app_id or by internal object?
   - What happens if a sandbox creation times out?

4. **Concurrency control:**
   - How is `max_concurrent_creates` enforced?
   - Is there a semaphore/lock that could be failing?

#### Step 5: Potential Fixes to Try

1. **Add mutex around pool scaling logic:**
   ```python
   self._scaling_lock = asyncio.Lock()

   async def _scale_pool(self):
       async with self._scaling_lock:
           # Only one scaling operation at a time
           ...
   ```

2. **Add reconciliation with DO API:**
   ```python
   async def _reconcile_with_do(self):
       # Fetch actual apps from DO
       actual_apps = await self._list_sandbox_apps()
       # Compare with tracked sandboxes
       # Remove orphans, update tracking
   ```

3. **Add strict limit enforcement:**
   ```python
   if self._ready_count >= self._max_ready:
       logger.warning("At max_ready, skipping creation")
       return
   ```

### Files to Modify in SDK

| File | What to Check |
|------|---------------|
| `sandbox_manager.py` | Main pool logic, background tasks |
| `pool.py` or `pool_manager.py` | Pool state tracking |
| Any file with `asyncio.create_task` | Background tasks that might race |

---

## Issue 2: Node Pool Removed (DONE)

The Node pool has been removed from the configuration. Only Python pool remains (when re-enabled).

- Tic-Tac-Toe game will use cold start
- Snake and Memory will use warm pool (when fixed)

---

## Issue 3: SSE Log Streaming (LOW PRIORITY)

Per-launch SSE streaming is broken. Main orchestrator logs work.

**Status:** Deferred until SDK bug is fixed.

---

## Issue 4: Game Verification (MEDIUM PRIORITY)

All 3 games need testing with cold starts.

**Status:** Can test now since warm pool is disabled.

---

## Current Configuration

### app.yaml (AFTER FIX)

```yaml
WARM_POOL_ENABLED: "false"           # DISABLED - SDK bug
WARM_POOL_TARGET_READY: "2"
WARM_POOL_MAX_READY: "3"
WARM_POOL_IDLE_TIMEOUT: "600"
WARM_POOL_MAX_CONCURRENT_CREATES: "1"
```

### cold_service.py (AFTER FIX)

```python
# Only Python pool (Node removed)
"python": PoolConfig(
    target_ready=target_ready,
    max_ready=target_ready + 1,     # Strict limit
    idle_timeout=600,                # 10 min
    scale_down_delay=120,
    max_warm_age=3600,
    on_empty="create",
),
max_total_sandboxes=target_ready + 3,  # Strict global limit
max_concurrent_creates=1,               # Serialize creations
```

---

## Priority Order (UPDATED)

1. **Issue 1 (SDK Bug)** - CRITICAL - Must fix before re-enabling warm pool
2. **Issue 4 (Games)** - MEDIUM - Test cold starts work
3. **Issue 3 (SSE)** - LOW - Nice to have

---

## Cleanup Commands

```bash
# Delete all sandbox apps
doctl apps list --format ID,Spec.Name | grep sandbox | awk '{print $1}' | xargs -I {} doctl apps delete {} --force

# Verify cleanup
doctl apps list | grep sandbox

# Check orchestrator status
curl -s "https://orchestrator-demo-3cu9r.ondigitalocean.app/api/pool/status"

# Redeploy orchestrator
doctl apps create-deployment 93325ad4-ec00-4211-862c-23489ec3e32c
```

---

## Success Criteria

1. **SDK bug fixed** - Pool respects max_ready limit
2. **Warm pool stable** - Creates exactly target_ready sandboxes, no churn
3. **All games work** - Snake, Memory, Tic-Tac-Toe playable
4. **SSE streaming** (nice to have) - Per-launch logs work

---

## Key Files

| File | Purpose |
|------|---------|
| `backend/services/cold_service.py` | Pool manager config |
| `backend/config.py` | Environment variable defaults |
| `backend/main.py` | API endpoints |
| `.do/app.yaml` | App Platform deployment config |
| **SDK: `sandbox_manager.py`** | **BUG LOCATION - needs debugging** |
