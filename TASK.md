# Orchestrator Demo

**App URL:** https://orchestrator-demo-bh5qp.ondigitalocean.app/
**App ID:** f082ab70-a6b1-4090-bf08-26409faed1db

---

## Completed (2026-01-12)

- ✅ Cold start UX (double-launch, timer, deletion logs, expired list)
- ✅ All games Python (Snake, Memory, Tic-Tac-Toe)
- ✅ Detailed orchestrator logs (snapshot download, extract, install, etc.)
- ✅ Simplified UI (removed tabs, compact launch cards, sandbox list)
- ✅ Time remaining countdown for active sandboxes
- ✅ Deleted sandboxes persist to backend (survives refresh)
- ✅ Rate limiting working (3 cold, 3 warm, 25/hour)
- ✅ Warm pool enabled (SDK 0.2.2 fix applied)

---

## RESOLVED: SDK SandboxManager Bug

**Root cause:** Race condition between periodic health check and replenish loop.
Health check drained the queue temporarily → replenish saw `ready_count=0` → created duplicates.

**Fix:** Removed periodic health check entirely (do-app-sandbox 0.2.2). Lazy health check on acquire is sufficient.

**GitHub Issues:**
- https://github.com/bikramkgupta/do-app-sandbox/issues/22 (bug)
- https://github.com/bikramkgupta/do-app-sandbox/issues/23 (scale review)

---

## Useful Commands

```bash
# Delete all sandbox apps
doctl apps list --format ID,Spec.Name | grep sandbox | awk '{print $1}' | xargs -I {} doctl apps delete {} --force

# Check pool status
curl -s "https://orchestrator-demo-bh5qp.ondigitalocean.app/api/pool/status"

# Redeploy
doctl apps create-deployment f082ab70-a6b1-4090-bf08-26409faed1db
```
