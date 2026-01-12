# Orchestrator Demo - Remaining Task

**App URL:** https://orchestrator-demo-3cu9r.ondigitalocean.app/
**App ID:** 93325ad4-ec00-4211-862c-23489ec3e32c

---

## Completed (2026-01-12)

- ✅ Cold start UX (double-launch, timer, deletion logs, expired list)
- ✅ All games Python (Snake, Memory, Tic-Tac-Toe)
- ✅ Detailed orchestrator logs (snapshot download, extract, install, etc.)
- ✅ Simplified UI (removed tabs, compact launch cards, sandbox list)
- ✅ Time remaining countdown for active sandboxes
- ✅ Deleted sandboxes persist to backend (survives refresh)
- ✅ Rate limiting working (3 cold, 3 warm, 25/hour)

---

## Remaining: SDK SandboxManager Bug (BLOCKING WARM POOL)

### Status: PENDING - Needs SDK Fix

The warm pool is **disabled** (`WARM_POOL_ENABLED: "false"`) due to a confirmed SDK bug.

### Problem

The `do-app-sandbox` SDK's `SandboxManager` creates sandboxes in an infinite loop:

1. **Does not respect `max_ready` limit** - Creates 5+ sandboxes when max_ready=3
2. **Does not properly track sandboxes** - Metrics fluctuate wildly
3. **Continuously creates sandboxes** - Even when above target_ready

### Evidence (2026-01-11)

```
Pool: ready=3, creating=0  ← Good, at max_ready=3
Pool: ready=3, creating=2  ← BUG! Creating when already at max!
Pool: ready=1, creating=1  ← Lost track of sandboxes!
Pool: ready=5, creating=1  ← ready=5 exceeds max_ready=3!
```

### SDK Location

**Repository:** https://github.com/bikramkgupta/do-app-sandbox
**Key file:** `do_app_sandbox/sandbox_manager.py`

### Debugging Steps

1. Clone SDK and add debug logging to pool management
2. Run minimal reproduction script (see below)
3. Check for race conditions in background tasks
4. Look for missing mutex around scaling logic

### Minimal Reproduction Script

```python
#!/usr/bin/env python3
"""Run OUTSIDE orchestrator to isolate the issue."""
import asyncio
import os
from datetime import datetime
from do_app_sandbox import SandboxManager, PoolConfig, SandboxMode

async def test_pool_stability():
    manager = SandboxManager(
        pools={
            "python": PoolConfig(
                target_ready=2,
                max_ready=3,
                idle_timeout=600,
                on_empty="create",
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

    # Monitor for 5 minutes - should stabilize at 2-3, never exceed 3
    for i in range(30):
        metrics = manager.metrics()
        pool = metrics.get("python", {})
        ready = pool.get("ready", 0)
        creating = pool.get("creating", 0)

        issues = []
        if ready > 3: issues.append(f"READY EXCEEDS MAX!")
        if creating > 1: issues.append(f"CONCURRENT CREATES EXCEEDS LIMIT!")

        print(f"[{i*10:3d}s] ready={ready}, creating={creating} | {' '.join(issues) or 'OK'}")
        await asyncio.sleep(10)

    await manager.shutdown()

if __name__ == "__main__":
    asyncio.run(test_pool_stability())
```

### Potential Fixes

1. Add mutex around pool scaling logic
2. Add reconciliation with DO API (fetch actual apps, compare with tracked)
3. Add strict limit enforcement before any creation

---

## Useful Commands

```bash
# Delete all sandbox apps
doctl apps list --format ID,Spec.Name | grep sandbox | awk '{print $1}' | xargs -I {} doctl apps delete {} --force

# Check pool status
curl -s "https://orchestrator-demo-3cu9r.ondigitalocean.app/api/pool/status"

# Redeploy
doctl apps create-deployment 93325ad4-ec00-4211-862c-23489ec3e32c
```

---

## Success Criteria

1. SDK bug fixed - Pool respects max_ready limit
2. Warm pool stable - Creates exactly target_ready sandboxes, no churn
3. Re-enable `WARM_POOL_ENABLED: "true"` in app.yaml
