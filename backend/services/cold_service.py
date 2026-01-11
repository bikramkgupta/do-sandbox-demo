"""Cold sandbox service using do-app-sandbox SDK."""
import asyncio
import logging
import random
import time
from datetime import datetime, timedelta
from typing import AsyncGenerator, Optional
from uuid import UUID, uuid4

from do_app_sandbox import Sandbox, SpacesConfig, SandboxMode

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from config import config
from models.schemas import (
    GameType,
    SandboxInfo,
    SandboxStatus,
    SandboxType,
    LogEvent,
    StatusEvent,
    ReadyEvent,
)
from services.rate_limiter import rate_limiter, RateLimitError


# Import SDK exceptions for retry logic
from do_app_sandbox.exceptions import ServiceConnectionError

# GitHub repo for games
GAMES_REPO = "https://github.com/bikramkgupta/do-sandbox-games.git"

# DNS propagation can take time after sandbox creation
DNS_PROPAGATION_DELAY = 15  # seconds to wait after sandbox is ready
EXEC_RETRY_ATTEMPTS = 5
EXEC_RETRY_DELAY = 5  # seconds between retries


def exec_with_retry(sandbox, command: str, timeout: int = 120, max_retries: int = EXEC_RETRY_ATTEMPTS):
    """Execute command with retry logic for DNS propagation issues."""
    last_error = None
    for attempt in range(max_retries):
        try:
            return sandbox.exec(command, timeout=timeout)
        except (ServiceConnectionError, Exception) as e:
            last_error = e
            error_msg = str(e)
            # Retry on DNS/connection errors
            if "Name or service not known" in error_msg or "Connection" in error_msg:
                if attempt < max_retries - 1:
                    logger.warning(f"Exec attempt {attempt + 1} failed ({error_msg}), retrying in {EXEC_RETRY_DELAY}s...")
                    time.sleep(EXEC_RETRY_DELAY)
                    continue
            raise
    raise last_error

# Game configurations
GAME_CONFIG = {
    GameType.SNAKE: {
        "image": "python",
        "path": "snake",
        "install": "pip install -r requirements.txt",
        "run": "python app.py",
        "snapshot_id": "snake-python",
    },
    GameType.TIC_TAC_TOE: {
        "image": "node",
        "path": "tic-tac-toe",
        "install": "npm install",
        "run": "npm start",
        "snapshot_id": "tictactoe-node",
    },
    GameType.MEMORY: {
        "image": "python",
        "path": "memory",
        "install": "pip install -r requirements.txt",
        "run": "python app.py",
        "snapshot_id": "memory-python",
    },
}


class SandboxRuntime:
    """Tracks a running sandbox."""

    def __init__(
        self,
        run_id: UUID,
        sandbox_type: SandboxType,
        game: GameType,
        use_snapshot: bool,
        sandbox: Optional[Sandbox] = None,
    ):
        self.run_id = run_id
        self.sandbox_type = sandbox_type
        self.game = game
        self.use_snapshot = use_snapshot
        self.sandbox = sandbox
        self.status = SandboxStatus.CREATING
        self.app_id: Optional[str] = None
        self.ingress_url: Optional[str] = None
        self.bootstrap_ms: Optional[int] = None
        self.restore_ms: Optional[int] = None
        self.total_ms: Optional[int] = None
        self.created_at = datetime.utcnow()
        self.expires_at: Optional[datetime] = None
        self.logs: list[str] = []

    def add_log(self, message: str) -> LogEvent:
        """Add a log message."""
        self.logs.append(message)
        return LogEvent(run_id=self.run_id, message=message)

    def to_info(self) -> SandboxInfo:
        """Convert to SandboxInfo."""
        duration_ms = None
        if self.status == SandboxStatus.RUNNING and self.created_at:
            duration_ms = int((datetime.utcnow() - self.created_at).total_seconds() * 1000)

        return SandboxInfo(
            run_id=self.run_id,
            type=self.sandbox_type,
            game=self.game,
            status=self.status,
            app_id=self.app_id,
            ingress_url=self.ingress_url,
            bootstrap_ms=self.bootstrap_ms,
            duration_ms=duration_ms,
            created_at=self.created_at,
            expires_at=self.expires_at,
        )


class ColdSandboxService:
    """Service for managing cold sandboxes."""

    def __init__(self):
        self._active_sandboxes: dict[str, SandboxRuntime] = {}
        self._event_queues: dict[str, asyncio.Queue] = {}

    def _get_spaces_config(self) -> Optional[SpacesConfig]:
        """Get Spaces configuration if available."""
        if config.SPACES_BUCKET and config.SPACES_ACCESS_KEY:
            return SpacesConfig(
                bucket=config.SPACES_BUCKET,
                region=config.SPACES_REGION,
                access_key=config.SPACES_ACCESS_KEY,
                secret_key=config.SPACES_SECRET_KEY,
            )
        return None

    async def launch(
        self,
        game: GameType,
        use_snapshot: bool = True,
        sandbox_type: SandboxType = SandboxType.COLD,
        triggered_by: str = "user",
    ) -> tuple[UUID, str]:
        """
        Launch a new sandbox.

        Returns: (run_id, stream_url)
        Raises: RateLimitError if limits exceeded
        """
        # Check rate limits FIRST
        type_str = "cold" if sandbox_type == SandboxType.COLD else "warm"
        can_launch, error = await rate_limiter.can_launch(type_str)
        if not can_launch:
            raise RateLimitError(error)

        # Generate run ID
        run_id = uuid4()

        # Create runtime tracker
        runtime = SandboxRuntime(
            run_id=run_id,
            sandbox_type=sandbox_type,
            game=game,
            use_snapshot=use_snapshot,
        )

        # Create event queue for SSE
        self._event_queues[str(run_id)] = asyncio.Queue()
        self._active_sandboxes[str(run_id)] = runtime

        # Register with rate limiter
        await rate_limiter.register_launch(str(run_id), type_str)

        # Start sandbox creation in background
        asyncio.create_task(self._create_sandbox(runtime))

        return run_id, f"/api/stream/{run_id}"

    async def _create_sandbox(self, runtime: SandboxRuntime) -> None:
        """Background task to create sandbox and deploy game."""
        queue = self._event_queues.get(str(runtime.run_id))
        total_start_time = time.time()

        logger.info(f"Starting sandbox creation for run_id={runtime.run_id}, game={runtime.game}")

        try:
            game_config = GAME_CONFIG[runtime.game]

            # Step 1: Create/acquire sandbox
            logger.info(f"Step 1: Creating {runtime.sandbox_type.value} sandbox...")
            await self._emit(queue, runtime.add_log(f"Creating {runtime.sandbox_type.value} sandbox..."))
            await self._emit(queue, StatusEvent(run_id=runtime.run_id, status=SandboxStatus.CREATING))

            bootstrap_start = time.time()

            logger.info(f"Calling Sandbox.create() with image={game_config['image']}, mode=SERVICE")
            sandbox = Sandbox.create(
                image=game_config["image"],
                api_token=config.DIGITALOCEAN_TOKEN,
                spaces_config=self._get_spaces_config(),
                mode=SandboxMode.SERVICE,  # Use HTTP API instead of doctl console
                wait_ready=True,
                timeout=120,
            )
            logger.info(f"Sandbox created successfully: app_id={sandbox.app_id}")

            bootstrap_ms = int((time.time() - bootstrap_start) * 1000)
            runtime.bootstrap_ms = bootstrap_ms
            runtime.sandbox = sandbox
            runtime.app_id = sandbox.app_id

            await self._emit(queue, runtime.add_log(f"Sandbox ready in {bootstrap_ms}ms"))
            await self._emit(queue, runtime.add_log(f"App ID: {sandbox.app_id}"))

            # Wait for DNS propagation before trying to connect
            await self._emit(queue, runtime.add_log(f"Waiting {DNS_PROPAGATION_DELAY}s for DNS propagation..."))
            await asyncio.sleep(DNS_PROPAGATION_DELAY)

            # Step 2: Deploy game (snapshot or git clone)
            restore_start = time.time()

            if runtime.use_snapshot:
                await self._deploy_with_snapshot(runtime, queue, game_config)
            else:
                await self._deploy_from_github(runtime, queue, game_config)

            restore_ms = int((time.time() - restore_start) * 1000)
            runtime.restore_ms = restore_ms

            # Step 3: Start the game (use service client's exec_background in SERVICE mode)
            await self._emit(queue, runtime.add_log(f"Starting {runtime.game.value} game..."))
            run_cmd = f"cd /workspace/{game_config['path']} && {game_config['run']}"
            # SERVICE mode: use exec_background via HTTP client
            if sandbox.mode == SandboxMode.SERVICE:
                client = sandbox._get_service_client()
                pid = client.exec_background(run_cmd, cwd="/workspace")
                logger.info(f"Started game process with PID {pid}")
            else:
                sandbox.launch_process(run_cmd)

            # Get the URL
            ingress_url = sandbox.get_url()
            runtime.ingress_url = ingress_url

            # Set expiry
            lifetime_minutes = random.randint(
                config.SANDBOX_MIN_LIFETIME_MINUTES,
                config.SANDBOX_MAX_LIFETIME_MINUTES
            )
            runtime.expires_at = datetime.utcnow() + timedelta(minutes=lifetime_minutes)

            # Calculate total time
            total_ms = int((time.time() - total_start_time) * 1000)
            runtime.total_ms = total_ms

            # Update status
            runtime.status = SandboxStatus.RUNNING
            await self._emit(queue, StatusEvent(run_id=runtime.run_id, status=SandboxStatus.RUNNING))
            await self._emit(queue, ReadyEvent(
                run_id=runtime.run_id,
                ingress_url=ingress_url,
                bootstrap_ms=bootstrap_ms,
                restore_ms=restore_ms,
                total_ms=total_ms,
            ))
            await self._emit(queue, runtime.add_log(f"Game live at: {ingress_url}"))
            await self._emit(queue, runtime.add_log(f"Total time: {total_ms}ms"))
            await self._emit(queue, runtime.add_log(f"Auto-cleanup in {lifetime_minutes} minutes"))

        except Exception as e:
            logger.error(f"Sandbox creation failed for run_id={runtime.run_id}: {str(e)}", exc_info=True)
            runtime.status = SandboxStatus.FAILED
            await self._emit(queue, runtime.add_log(f"ERROR: {str(e)}"))
            await self._emit(queue, StatusEvent(run_id=runtime.run_id, status=SandboxStatus.FAILED))
            # Clean up on failure
            await self.delete(runtime.run_id)

    async def _deploy_with_snapshot(self, runtime: SandboxRuntime, queue, game_config: dict) -> None:
        """Deploy game by restoring from snapshot."""
        await self._emit(queue, runtime.add_log("Restoring from snapshot..."))

        snapshot_id = game_config["snapshot_id"]
        game_path = game_config["path"]

        # Construct snapshot URL from Spaces configuration
        if config.SPACES_BUCKET and config.SPACES_REGION:
            snapshot_url = f"https://{config.SPACES_BUCKET}.{config.SPACES_REGION}.digitaloceanspaces.com/snapshots/{snapshot_id}.tar.gz"
            await self._emit(queue, runtime.add_log(f"Downloading snapshot: {snapshot_id}"))

            # Download snapshot (with retry for DNS propagation)
            result = exec_with_retry(
                runtime.sandbox,
                f"wget -q -O /tmp/snapshot.tar.gz {snapshot_url}",
                timeout=60
            )

            if result.success:
                # Extract snapshot
                await self._emit(queue, runtime.add_log("Extracting snapshot..."))
                result = exec_with_retry(
                    runtime.sandbox,
                    f"cd /workspace && tar -xzf /tmp/snapshot.tar.gz",
                    timeout=30
                )
                if result.success:
                    await self._emit(queue, runtime.add_log("Snapshot restored successfully"))

                    # Still need to install deps (snapshots contain code, not installed deps)
                    await self._emit(queue, runtime.add_log("Installing dependencies..."))
                    install_cmd = game_config["install"]
                    result = exec_with_retry(
                        runtime.sandbox,
                        f"cd /workspace/{game_path} && {install_cmd}",
                        timeout=120
                    )
                    if not result.success:
                        await self._emit(queue, runtime.add_log(f"Warning: {result.stderr}"))

                    await self._emit(queue, runtime.add_log("Dependencies installed"))
                    return
                else:
                    await self._emit(queue, runtime.add_log(f"Extract failed: {result.stderr}"))
            else:
                await self._emit(queue, runtime.add_log("Snapshot not found, falling back to GitHub..."))

        # Fallback to git clone if snapshot not available
        await self._deploy_from_github(runtime, queue, game_config)

    async def _deploy_from_github(self, runtime: SandboxRuntime, queue, game_config: dict) -> None:
        """Deploy game by cloning from GitHub."""
        await self._emit(queue, runtime.add_log(f"Cloning from {GAMES_REPO}..."))

        # Clone the repo (with retry for DNS propagation)
        result = exec_with_retry(
            runtime.sandbox,
            f"git clone --depth 1 {GAMES_REPO} /workspace/games",
            timeout=60
        )
        if not result.success:
            raise Exception(f"Git clone failed: {result.stderr}")

        await self._emit(queue, runtime.add_log("Repository cloned"))

        # Move game to workspace
        game_path = game_config["path"]
        exec_with_retry(runtime.sandbox, f"mv /workspace/games/{game_path} /workspace/{game_path}", timeout=30)

        # Install dependencies
        await self._emit(queue, runtime.add_log(f"Installing dependencies..."))
        install_cmd = game_config["install"]
        result = exec_with_retry(
            runtime.sandbox,
            f"cd /workspace/{game_path} && {install_cmd}",
            timeout=120
        )
        if not result.success:
            await self._emit(queue, runtime.add_log(f"Warning: {result.stderr}"))

        await self._emit(queue, runtime.add_log("Dependencies installed"))

    async def _emit(self, queue: Optional[asyncio.Queue], event) -> None:
        """Emit event to queue if it exists."""
        if queue:
            await queue.put(event)

    async def stream_events(self, run_id: UUID) -> AsyncGenerator:
        """Stream events for a sandbox."""
        queue = self._event_queues.get(str(run_id))
        if not queue:
            return

        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=30)
                yield event
            except asyncio.TimeoutError:
                # Send keepalive
                yield {"type": "keepalive"}

    async def delete(self, run_id: UUID) -> bool:
        """Delete a sandbox and clean up resources."""
        run_id_str = str(run_id)

        runtime = self._active_sandboxes.get(run_id_str)
        if not runtime:
            return False

        try:
            if runtime.sandbox:
                runtime.sandbox.delete()
        except Exception:
            pass  # Best effort cleanup

        # Clean up tracking
        self._active_sandboxes.pop(run_id_str, None)
        self._event_queues.pop(run_id_str, None)
        await rate_limiter.unregister_sandbox(run_id_str)

        return True

    def get_sandbox(self, run_id: UUID) -> Optional[SandboxInfo]:
        """Get sandbox info by run ID."""
        runtime = self._active_sandboxes.get(str(run_id))
        if runtime:
            return runtime.to_info()
        return None

    def get_active_sandboxes(self) -> list[SandboxInfo]:
        """Get all active sandboxes."""
        return [runtime.to_info() for runtime in self._active_sandboxes.values()]

    async def cleanup_expired(self) -> int:
        """Delete expired sandboxes. Returns count of deleted."""
        now = datetime.utcnow()
        expired = []

        for run_id, runtime in self._active_sandboxes.items():
            if runtime.expires_at and runtime.expires_at <= now:
                expired.append(UUID(run_id))

        for run_id in expired:
            await self.delete(run_id)

        return len(expired)


# Global service instance
cold_service = ColdSandboxService()
