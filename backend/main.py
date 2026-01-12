"""FastAPI application for DO App Sandbox Demo."""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from uuid import UUID

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from sse_starlette.sse import EventSourceResponse

from config import config
from models.schemas import (
    ErrorResponse,
    GameType,
    LaunchRequest,
    LaunchResponse,
    SandboxInfo,
    SandboxStatus,
    SandboxType,
    StatusResponse,
    PoolStatus,
    RateStatus,
    ActiveSandboxes,
    HistoryItem,
    StatsResponse,
)
from services.rate_limiter import rate_limiter, RateLimitError
from services.cold_service import cold_service, sandbox_service


# Background cleanup task - only affects user-launched sandboxes, not SDK pool
async def cleanup_task():
    """Periodically clean up expired sandboxes."""
    while True:
        try:
            count = await cold_service.cleanup_expired()
            if count > 0:
                print(f"Cleaned up {count} expired sandboxes")
        except Exception as e:
            print(f"Cleanup error: {e}")
        await asyncio.sleep(config.CLEANUP_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    # Validate configuration
    missing = config.validate()
    if missing:
        print(f"WARNING: Missing configuration: {missing}")

    # Start background cleanup task
    cleanup = asyncio.create_task(cleanup_task())
    print("Started cleanup background task")

    # Start warm pool manager (runs in background, doesn't block)
    print("Starting warm pool manager...")
    await sandbox_service.start_pool_manager()

    yield

    # Shutdown warm pool manager
    print("Shutting down warm pool manager...")
    await sandbox_service.shutdown_pool_manager()

    # Cleanup on shutdown
    cleanup.cancel()
    try:
        await cleanup
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="DO App Sandbox Demo",
    description="Interactive demo of DigitalOcean App Platform Sandbox capabilities",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure properly for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Health check
@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}


# Launch endpoints
@app.post("/api/launch/cold", response_model=LaunchResponse)
async def launch_cold(request: LaunchRequest):
    """Launch a new cold sandbox."""
    try:
        run_id, stream_url = await cold_service.launch(
            game=request.game,
            use_snapshot=request.use_snapshot,
            sandbox_type=SandboxType.COLD,
        )
        snapshot_text = "with snapshot" if request.use_snapshot else "from GitHub"
        return LaunchResponse(
            run_id=run_id,
            stream_url=stream_url,
            message=f"Launching cold sandbox {snapshot_text} for {request.game.value} game",
        )
    except RateLimitError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/launch/warm", response_model=LaunchResponse)
async def launch_warm(request: LaunchRequest):
    """Launch a sandbox from warm pool (uses cold for MVP, warm pool TBD)."""
    try:
        # TODO: Implement actual warm pool service
        # For now, this still creates a cold sandbox but tracks it as "warm" type
        run_id, stream_url = await cold_service.launch(
            game=request.game,
            use_snapshot=request.use_snapshot,
            sandbox_type=SandboxType.WARM,
        )
        snapshot_text = "with snapshot" if request.use_snapshot else "from GitHub"
        return LaunchResponse(
            run_id=run_id,
            stream_url=stream_url,
            message=f"Acquiring warm sandbox {snapshot_text} for {request.game.value} game",
        )
    except RateLimitError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Sandbox management
@app.get("/api/sandbox/{run_id}", response_model=SandboxInfo)
async def get_sandbox(run_id: UUID):
    """Get sandbox information."""
    sandbox = cold_service.get_sandbox(run_id)
    if not sandbox:
        raise HTTPException(status_code=404, detail="Sandbox not found")
    return sandbox


@app.delete("/api/sandbox/{run_id}")
async def delete_sandbox(run_id: UUID):
    """Delete a sandbox."""
    success = await cold_service.delete(run_id)
    if not success:
        raise HTTPException(status_code=404, detail="Sandbox not found")
    return {"message": "Sandbox deleted", "run_id": str(run_id)}


# Game proxy - forward requests to sandbox's game server
@app.api_route("/api/game/{run_id}", methods=["GET", "POST", "PUT", "DELETE"])
@app.api_route("/api/game/{run_id}/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def game_proxy(run_id: UUID, request: Request, path: str = ""):
    """Proxy requests to the game running inside a sandbox.

    This allows users to access games without needing the sandbox's
    service token (which is stored server-side).
    """
    runtime = cold_service.get_runtime(run_id)
    if not runtime:
        raise HTTPException(status_code=404, detail="Sandbox not found")

    if not runtime.sandbox_base_url or not runtime.service_token:
        raise HTTPException(status_code=503, detail="Sandbox not ready for proxying")

    # Build target URL
    target_url = f"{runtime.sandbox_base_url}/proxy/{runtime.game_port}/{path}"
    if request.query_params:
        target_url += f"?{request.query_params}"

    # Proxy the request
    headers = {"Authorization": f"Bearer {runtime.service_token}"}

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            # Forward request body if present
            body = await request.body() if request.method in ["POST", "PUT"] else None

            response = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
            )

            # Return proxied response
            return Response(
                content=response.content,
                status_code=response.status_code,
                headers={
                    k: v for k, v in response.headers.items()
                    if k.lower() not in ["content-encoding", "content-length", "transfer-encoding"]
                },
                media_type=response.headers.get("content-type", "text/html"),
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Failed to proxy to sandbox: {e}")


# Streaming
@app.get("/api/stream/{run_id}")
async def stream_sandbox(run_id: UUID):
    """Stream sandbox events via SSE."""

    async def event_generator():
        async for event in cold_service.stream_events(run_id):
            if isinstance(event, dict):
                yield {"event": event.get("type", "message"), "data": ""}
            else:
                yield {
                    "event": event.type,
                    "data": event.model_dump_json(),
                }

    return EventSourceResponse(event_generator())


# Status endpoints
@app.get("/api/status", response_model=StatusResponse)
async def get_status():
    """Get current system status."""
    rate_status = await rate_limiter.get_status()
    active = cold_service.get_active_sandboxes()

    # Count by type
    cold_count = sum(1 for s in active if s.type.value == "cold")
    warm_count = sum(1 for s in active if s.type.value == "warm")
    snapshot_count = sum(1 for s in active if s.type.value == "snapshot")

    # Get pool status
    pool_status = sandbox_service.get_pool_status()

    return StatusResponse(
        active=active,
        active_counts=ActiveSandboxes(
            cold=cold_count,
            warm=warm_count,
            snapshot=snapshot_count,
            total=len(active),
        ),
        pool=PoolStatus(
            ready=pool_status.get("ready", 0),
            creating=pool_status.get("creating", 0),
            in_use=pool_status.get("in_use", warm_count),
        ),
        rate=RateStatus(
            used=rate_status["rate"]["used"],
            limit=rate_status["rate"]["limit"],
            reset_in_seconds=rate_status["rate"]["reset_in_seconds"],
        ),
    )


@app.get("/api/history")
async def get_history(
    limit: int = Query(default=10, ge=1, le=20),
):
    """Get recently deleted sandboxes history."""
    deleted = cold_service.get_deleted_sandboxes(limit)
    return {"deleted": deleted, "count": len(deleted)}


@app.get("/api/stats", response_model=StatsResponse)
async def get_stats():
    """Get aggregated statistics."""
    # TODO: Implement database-backed stats
    return StatsResponse(
        total_runs=0,
        by_type={"cold": 0, "warm": 0, "snapshot": 0},
        avg_times={"cold_ms": None, "warm_ms": None, "snapshot_ms": None},
        pool_hit_rate=0.0,
    )


@app.get("/api/limits")
async def get_limits():
    """Get current rate limit status."""
    return await rate_limiter.get_status()


@app.get("/api/orchestrator/logs")
async def get_orchestrator_logs(limit: int = Query(default=50, ge=1, le=100)):
    """Get recent orchestrator logs for UI transparency."""
    return {
        "logs": sandbox_service.get_orchestrator_logs(limit),
        "count": len(sandbox_service.get_orchestrator_logs(limit)),
    }


@app.get("/api/pool/status")
async def get_pool_status():
    """Get warm pool status."""
    return sandbox_service.get_pool_status()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
