"""Cold and warm sandbox service using do-app-sandbox SDK."""
import asyncio
import logging
import random
import time
from datetime import datetime, timedelta
from typing import AsyncGenerator, Optional
from uuid import UUID, uuid4

from do_app_sandbox import Sandbox, SpacesConfig, SandboxMode, SandboxManager, PoolConfig

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

# Game port - use 5000 to avoid conflict with sandbox API server on 8080
GAME_PORT = 5000

# Game configurations
GAME_CONFIG = {
    GameType.SNAKE: {
        "image": "python",
        "path": "snake",
        "install": "pip install -r requirements.txt",
        "run": f"sed -i 's/port=8080/port={GAME_PORT}/' app.py && python app.py",
        "snapshot_id": "snake-python",
        "port": GAME_PORT,
    },
    GameType.TIC_TAC_TOE: {
        "image": "python",
        "path": "tic-tac-toe-python",
        "install": "pip install -r requirements.txt",
        "run": f"sed -i 's/port=8080/port={GAME_PORT}/' app.py && python app.py",
        "snapshot_id": "tictactoe-python",
        "port": GAME_PORT,
    },
    GameType.MEMORY: {
        "image": "python",
        "path": "memory",
        "install": "pip install -r requirements.txt",
        "run": f"sed -i 's/port=8080/port={GAME_PORT}/' app.py && python app.py",
        "snapshot_id": "memory-python",
        "port": GAME_PORT,
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
        # SERVICE mode: store service token and port for proxying
        self.service_token: Optional[str] = None
        self.game_port: int = GAME_PORT
        self.sandbox_base_url: Optional[str] = None

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


class SandboxService:
    """Service for managing cold and warm sandboxes with pool pre-warming."""

    def __init__(self):
        self._active_sandboxes: dict[str, SandboxRuntime] = {}
        self._event_queues: dict[str, asyncio.Queue] = {}
        # Pool manager for warm sandboxes
        self._pool_manager: Optional[SandboxManager] = None
        self._pool_started = False
        # Orchestrator log for UI transparency (recent events)
        self._orchestrator_logs: list[dict] = []
        self._max_orchestrator_logs = 100
        # Deleted sandboxes history (in-memory, keeps last 20)
        self._deleted_sandboxes: list[dict] = []
        self._max_deleted_sandboxes = 20

    def _log_orchestrator(self, message: str, level: str = "info"):
        """Add a message to the orchestrator log."""
        log_entry = {
            "timestamp": datetime.utcnow().isoformat(),
            "level": level,
            "message": message,
        }
        self._orchestrator_logs.append(log_entry)
        # Keep only recent logs
        if len(self._orchestrator_logs) > self._max_orchestrator_logs:
            self._orchestrator_logs = self._orchestrator_logs[-self._max_orchestrator_logs:]
        logger.log(getattr(logging, level.upper(), logging.INFO), f"[ORCHESTRATOR] {message}")

    def get_orchestrator_logs(self, limit: int = 50) -> list[dict]:
        """Get recent orchestrator logs."""
        return self._orchestrator_logs[-limit:]

    async def start_pool_manager(self):
        """Initialize and start the warm pool manager.

        Based on SDK docs (sandbox_manager.md):
        - target_ready: Desired count of ready sandboxes when active
        - max_ready: Upper limit for warming capacity (hard ceiling)
        - max_concurrent_creates: Limits parallel sandbox creations
        - idle_timeout: Seconds before scaling down begins
        - on_empty: "create" falls back to cold start, "fail" raises PoolExhaustedError

        Pool behavior:
        - Starts idle (0 warm) unless warm_up() is called
        - Scales to target_ready on first acquire, then maintains that level
        - Scales down after idle_timeout of no acquires
        """
        if self._pool_started:
            return

        # Check if warm pool is enabled
        if not config.WARM_POOL_ENABLED:
            self._log_orchestrator("Warm pool disabled (set WARM_POOL_ENABLED=true to enable)")
            return

        self._log_orchestrator("Initializing warm pool manager...")

        try:
            # Configuration from environment (with sensible defaults)
            target_ready = config.WARM_POOL_TARGET_READY  # Default: 2
            max_ready = config.WARM_POOL_MAX_READY  # Default: 10
            idle_timeout = config.WARM_POOL_IDLE_TIMEOUT  # Default: 120 (2 min)
            max_concurrent_creates = config.WARM_POOL_MAX_CONCURRENT_CREATES  # Default: 2

            # CRITICAL FIX: Simplified pool configuration to prevent churn
            # - Only Python pool (Node games will cold-start)
            # - max_ready close to target_ready to prevent over-provisioning
            # - Reduced max_total_sandboxes to limit runaway creation
            # - max_concurrent_creates=1 to serialize sandbox creation
            self._pool_manager = SandboxManager(
                pools={
                    # Python pool only - for snake and memory games
                    # Tic-tac-toe (Node) will fall back to cold start
                    "python": PoolConfig(
                        target_ready=target_ready,
                        max_ready=target_ready + 1,  # Only 1 above target to prevent over-provisioning
                        idle_timeout=600,  # 10 min idle before scale-down (was 120s causing churn)
                        scale_down_delay=120,  # Slow scale-down: 1 sandbox every 2 min
                        cooldown_after_acquire=300,  # Pause scale-down for 5 min after acquire
                        max_warm_age=3600,  # Cycle sandboxes after 1 hour (was 30 min)
                        on_empty="create",  # Fallback to cold start if pool empty
                        create_retries=2,
                        create_retry_delay=10,
                    ),
                    # Node pool REMOVED - tic-tac-toe will use cold start
                },
                max_total_sandboxes=target_ready + 3,  # Strict limit: target + small buffer
                max_concurrent_creates=1,  # CRITICAL: Only 1 sandbox creation at a time
                sandbox_defaults={
                    "region": "syd",
                    "api_token": config.DIGITALOCEAN_TOKEN,
                    "mode": SandboxMode.SERVICE,
                },
            )

            await self._pool_manager.start()
            self._log_orchestrator(
                f"Warm pool started: target={target_ready}, max={target_ready + 1}, "
                f"max_creates=1, idle_timeout=600s (Python only, Node will cold-start)"
            )

            # IMPORTANT: Do NOT call warm_up() proactively
            # Let pool start idle (0 sandboxes) and scale to target_ready on first acquire
            # This prevents the churn issue where sandboxes are created before any user demand
            self._log_orchestrator("Pool starting idle - will scale on first user request")

            self._pool_started = True
        except Exception as e:
            self._log_orchestrator(f"Failed to start pool manager: {e}", level="error")
            logger.error(f"Pool manager start failed: {e}", exc_info=True)

    async def _warm_up_pool(self):
        """Background task to warm up the pool.

        Uses a 60s timeout - if pool isn't ready by then, continue anyway.
        Pool will continue warming in background and be ready for future requests.
        """
        try:
            self._log_orchestrator("Warming up pool (60s timeout)...")
            await self._pool_manager.warm_up(timeout=60)
            metrics = self._pool_manager.metrics()
            python_ready = metrics.get("python", {}).get("ready", 0) if isinstance(metrics.get("python"), dict) else 0
            node_ready = metrics.get("node", {}).get("ready", 0) if isinstance(metrics.get("node"), dict) else 0
            self._log_orchestrator(f"Warm pool ready: {python_ready} python, {node_ready} node sandboxes")
        except asyncio.TimeoutError:
            self._log_orchestrator("Pool warm-up timed out, will continue warming in background", level="warning")
        except Exception as e:
            self._log_orchestrator(f"Pool warm-up error: {e}", level="warning")
            logger.warning(f"Pool warm-up failed: {e}")

    async def shutdown_pool_manager(self):
        """Shutdown the pool manager."""
        if self._pool_manager:
            self._log_orchestrator("Shutting down warm pool manager...")
            try:
                await self._pool_manager.shutdown()
            except Exception as e:
                self._log_orchestrator(f"Pool shutdown error: {e}", level="error")
            self._pool_started = False

    def get_pool_status(self) -> dict:
        """Get current warm pool status (Python pool only)."""
        if not self._pool_manager:
            return {"ready": 0, "creating": 0, "in_use": 0, "pool_started": False}

        try:
            metrics = self._pool_manager.metrics()
            # Handle both dict and object metrics - Python pool only
            python_metrics = metrics.get("python", {})

            if hasattr(python_metrics, 'ready'):
                python_ready = python_metrics.ready
                python_creating = python_metrics.creating
            else:
                python_ready = python_metrics.get("ready", 0)
                python_creating = python_metrics.get("creating", 0)

            return {
                "ready": python_ready,
                "creating": python_creating,
                "in_use": sum(1 for r in self._active_sandboxes.values() if r.sandbox_type == SandboxType.WARM),
                "pool_started": self._pool_started,
                "python": {"ready": python_ready, "creating": python_creating},
                # Node pool removed - tic-tac-toe uses cold start
            }
        except Exception as e:
            logger.warning(f"Failed to get pool metrics: {e}")
            return {"ready": 0, "creating": 0, "in_use": 0, "pool_started": self._pool_started, "error": str(e)}

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
            self._log_orchestrator(f"Rate limit exceeded for {type_str} launch: {error}", level="warning")
            raise RateLimitError(error)

        # Generate run ID
        run_id = uuid4()

        # Log to orchestrator
        snapshot_text = "with snapshot" if use_snapshot else "from GitHub"
        self._log_orchestrator(f"Launch request: {type_str} sandbox for {game.value} {snapshot_text}")

        # Get pool status for warm launches
        if sandbox_type == SandboxType.WARM:
            pool_status = self.get_pool_status()
            self._log_orchestrator(f"Pool status: {pool_status['ready']} ready, {pool_status['creating']} creating")

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
        self._log_orchestrator(f"Starting {runtime.sandbox_type.value} sandbox for {runtime.game.value}")

        try:
            game_config = GAME_CONFIG[runtime.game]

            # Step 1: Create/acquire sandbox
            if runtime.sandbox_type == SandboxType.WARM and self._pool_manager and self._pool_started:
                # Use warm pool - instant acquisition
                logger.info(f"Step 1: Acquiring from warm pool...")
                await self._emit(queue, runtime.add_log("Acquiring sandbox from warm pool..."))
                await self._emit(queue, StatusEvent(run_id=runtime.run_id, status=SandboxStatus.CREATING))
                self._log_orchestrator(f"Acquiring {game_config['image']} sandbox from warm pool")

                bootstrap_start = time.time()

                try:
                    # Acquire from pool (should be instant if pool is warm)
                    sandbox = await self._pool_manager.acquire(image=game_config["image"])
                    bootstrap_ms = int((time.time() - bootstrap_start) * 1000)
                    self._log_orchestrator(f"Pool acquisition: {bootstrap_ms}ms (pool hit)")
                except Exception as pool_error:
                    # Pool empty or error - fall back to cold start
                    logger.warning(f"Pool acquisition failed: {pool_error}, falling back to cold start")
                    self._log_orchestrator(f"Pool miss: falling back to cold start", level="warning")
                    await self._emit(queue, runtime.add_log("Pool empty, falling back to cold start..."))

                    sandbox = Sandbox.create(
                        image=game_config["image"],
                        api_token=config.DIGITALOCEAN_TOKEN,
                        spaces_config=self._get_spaces_config(),
                        mode=SandboxMode.SERVICE,
                        wait_ready=True,
                        timeout=120,
                    )
                    bootstrap_ms = int((time.time() - bootstrap_start) * 1000)
                    self._log_orchestrator(f"Cold fallback complete: {bootstrap_ms}ms")

                logger.info(f"Sandbox acquired: app_id={sandbox.app_id}")
            else:
                # Cold start - create new sandbox
                logger.info(f"Step 1: Creating cold sandbox...")
                await self._emit(queue, runtime.add_log("Creating cold sandbox..."))
                await self._emit(queue, StatusEvent(run_id=runtime.run_id, status=SandboxStatus.CREATING))
                self._log_orchestrator(f"Creating cold {game_config['image']} sandbox")

                bootstrap_start = time.time()

                logger.info(f"Calling Sandbox.create() with image={game_config['image']}, mode=SERVICE")
                sandbox = Sandbox.create(
                    image=game_config["image"],
                    api_token=config.DIGITALOCEAN_TOKEN,
                    spaces_config=self._get_spaces_config(),
                    mode=SandboxMode.SERVICE,
                    wait_ready=True,
                    timeout=120,
                )
                logger.info(f"Sandbox created successfully: app_id={sandbox.app_id}")
                self._log_orchestrator(f"Cold sandbox created: {sandbox.app_id}")

            bootstrap_ms = int((time.time() - bootstrap_start) * 1000)
            runtime.bootstrap_ms = bootstrap_ms
            runtime.sandbox = sandbox
            runtime.app_id = sandbox.app_id
            # Store SERVICE mode details for proxying
            runtime.service_token = sandbox._service_token
            runtime.sandbox_base_url = sandbox.get_url()
            runtime.game_port = game_config.get("port", GAME_PORT)

            await self._emit(queue, runtime.add_log(f"Sandbox ready in {bootstrap_ms}ms"))
            await self._emit(queue, runtime.add_log(f"App ID: {sandbox.app_id}"))
            self._log_orchestrator(f"Sandbox {sandbox.app_id} ready in {bootstrap_ms}ms")

            # Wait for DNS propagation before trying to connect
            await self._emit(queue, runtime.add_log(f"Waiting {DNS_PROPAGATION_DELAY}s for DNS propagation..."))
            self._log_orchestrator(f"Waiting {DNS_PROPAGATION_DELAY}s for DNS propagation")
            await asyncio.sleep(DNS_PROPAGATION_DELAY)
            self._log_orchestrator(f"DNS propagation complete, proceeding with deployment")

            # Step 2: Deploy game (snapshot or git clone)
            restore_start = time.time()

            if runtime.use_snapshot:
                self._log_orchestrator(f"Deploying {runtime.game.value} from snapshot")
                await self._deploy_with_snapshot(runtime, queue, game_config)
            else:
                self._log_orchestrator(f"Deploying {runtime.game.value} from GitHub")
                await self._deploy_from_github(runtime, queue, game_config)

            restore_ms = int((time.time() - restore_start) * 1000)
            runtime.restore_ms = restore_ms
            self._log_orchestrator(f"Game deployed in {restore_ms}ms")

            # Step 3: Start the game (use service client's exec_background in SERVICE mode)
            await self._emit(queue, runtime.add_log(f"Starting {runtime.game.value} game..."))
            self._log_orchestrator(f"Starting {runtime.game.value} game process")
            run_cmd = f"cd /workspace/{game_config['path']} && {game_config['run']}"
            # SERVICE mode: use exec_background via HTTP client
            if sandbox.mode == SandboxMode.SERVICE:
                client = sandbox._get_service_client()
                pid = client.exec_background(run_cmd, cwd="/workspace")
                logger.info(f"Started game process with PID {pid}")
            else:
                sandbox.launch_process(run_cmd)

            # Get the URL - use orchestrator's game proxy for SERVICE mode
            # (sandbox proxy requires auth token which users don't have)
            if sandbox.mode == SandboxMode.SERVICE:
                # Return orchestrator proxy URL - frontend will use this
                ingress_url = f"/api/game/{runtime.run_id}"
            else:
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
            self._log_orchestrator(f"READY: {runtime.game.value} sandbox in {total_ms}ms (bootstrap: {bootstrap_ms}ms, deploy: {restore_ms}ms)")

            # Log pool replenishment for warm sandboxes
            if runtime.sandbox_type == SandboxType.WARM and self._pool_manager:
                self._log_orchestrator(f"Pool replenishment triggered (target: {config.MAX_CONCURRENT_WARM})")

        except Exception as e:
            logger.error(f"Sandbox creation failed for run_id={runtime.run_id}: {str(e)}", exc_info=True)
            self._log_orchestrator(f"FAILED: {runtime.game.value} sandbox - {str(e)}", level="error")
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
            self._log_orchestrator(f"Downloading snapshot: {snapshot_id}.tar.gz")

            # Download snapshot (with retry for DNS propagation)
            result = exec_with_retry(
                runtime.sandbox,
                f"wget -q -O /tmp/snapshot.tar.gz {snapshot_url}",
                timeout=60
            )

            if result.success:
                self._log_orchestrator(f"Snapshot downloaded successfully")
                # Extract snapshot
                await self._emit(queue, runtime.add_log("Extracting snapshot..."))
                self._log_orchestrator(f"Extracting snapshot to /workspace")
                result = exec_with_retry(
                    runtime.sandbox,
                    f"cd /workspace && tar -xzf /tmp/snapshot.tar.gz",
                    timeout=30
                )
                if result.success:
                    await self._emit(queue, runtime.add_log("Snapshot restored successfully"))
                    self._log_orchestrator(f"Snapshot extracted successfully")

                    # Still need to install deps (snapshots contain code, not installed deps)
                    await self._emit(queue, runtime.add_log("Installing dependencies..."))
                    self._log_orchestrator(f"Installing dependencies ({game_config['install']})")
                    install_cmd = game_config["install"]
                    result = exec_with_retry(
                        runtime.sandbox,
                        f"cd /workspace/{game_path} && {install_cmd}",
                        timeout=120
                    )
                    if not result.success:
                        await self._emit(queue, runtime.add_log(f"Warning: {result.stderr}"))
                        self._log_orchestrator(f"Dependency warning: {result.stderr[:100]}", level="warning")

                    await self._emit(queue, runtime.add_log("Dependencies installed"))
                    self._log_orchestrator(f"Dependencies installed successfully")
                    return
                else:
                    await self._emit(queue, runtime.add_log(f"Extract failed: {result.stderr}"))
                    self._log_orchestrator(f"Snapshot extract failed: {result.stderr[:100]}", level="error")
            else:
                await self._emit(queue, runtime.add_log("Snapshot not found, falling back to GitHub..."))
                self._log_orchestrator(f"Snapshot not found, falling back to GitHub", level="warning")

        # Fallback to git clone if snapshot not available
        await self._deploy_from_github(runtime, queue, game_config)

    async def _deploy_from_github(self, runtime: SandboxRuntime, queue, game_config: dict) -> None:
        """Deploy game by cloning from GitHub."""
        await self._emit(queue, runtime.add_log(f"Cloning from {GAMES_REPO}..."))
        self._log_orchestrator(f"Cloning repository: {GAMES_REPO}")

        # Clone the repo (with retry for DNS propagation)
        result = exec_with_retry(
            runtime.sandbox,
            f"git clone --depth 1 {GAMES_REPO} /workspace/games",
            timeout=60
        )
        if not result.success:
            self._log_orchestrator(f"Git clone failed: {result.stderr[:100]}", level="error")
            raise Exception(f"Git clone failed: {result.stderr}")

        await self._emit(queue, runtime.add_log("Repository cloned"))
        self._log_orchestrator(f"Repository cloned successfully")

        # Move game to workspace
        game_path = game_config["path"]
        exec_with_retry(runtime.sandbox, f"mv /workspace/games/{game_path} /workspace/{game_path}", timeout=30)
        self._log_orchestrator(f"Game files moved to /workspace/{game_path}")

        # Install dependencies
        await self._emit(queue, runtime.add_log(f"Installing dependencies..."))
        self._log_orchestrator(f"Installing dependencies ({game_config['install']})")
        install_cmd = game_config["install"]
        result = exec_with_retry(
            runtime.sandbox,
            f"cd /workspace/{game_path} && {install_cmd}",
            timeout=120
        )
        if not result.success:
            await self._emit(queue, runtime.add_log(f"Warning: {result.stderr}"))
            self._log_orchestrator(f"Dependency warning: {result.stderr[:100]}", level="warning")

        await self._emit(queue, runtime.add_log("Dependencies installed"))
        self._log_orchestrator(f"Dependencies installed successfully")

    async def _emit(self, queue: Optional[asyncio.Queue], event) -> None:
        """Emit event to queue if it exists."""
        if queue:
            await queue.put(event)

    async def stream_events(self, run_id: UUID) -> AsyncGenerator:
        """Stream events for a sandbox."""
        run_id_str = str(run_id)
        queue = self._event_queues.get(run_id_str)
        runtime = self._active_sandboxes.get(run_id_str)

        if not queue:
            return

        # First, replay any buffered logs that were emitted before SSE connected
        if runtime and runtime.logs:
            for log_message in runtime.logs:
                yield LogEvent(run_id=run_id, message=log_message)

        # If sandbox is already ready, send the ready event
        if runtime and runtime.status == SandboxStatus.RUNNING and runtime.ingress_url:
            yield ReadyEvent(
                run_id=run_id,
                ingress_url=runtime.ingress_url,
                bootstrap_ms=runtime.bootstrap_ms or 0,
                restore_ms=runtime.restore_ms,
                total_ms=runtime.total_ms or runtime.bootstrap_ms or 0,
            )

        # Then stream live events from the queue
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=30)
                yield event
            except asyncio.TimeoutError:
                # Send keepalive
                yield {"type": "keepalive"}

    async def delete(self, run_id: UUID, reason: str = "user request") -> bool:
        """Delete a sandbox and clean up resources."""
        run_id_str = str(run_id)

        runtime = self._active_sandboxes.get(run_id_str)
        if not runtime:
            return False

        # Calculate total runtime before deletion
        deleted_at = datetime.utcnow()
        duration_ms = int((deleted_at - runtime.created_at).total_seconds() * 1000)

        # Save to deleted history
        deleted_info = {
            "run_id": run_id_str,
            "type": runtime.sandbox_type.value,
            "game": runtime.game.value,
            "status": "deleted",
            "bootstrap_ms": runtime.bootstrap_ms,
            "duration_ms": duration_ms,
            "created_at": runtime.created_at.isoformat(),
            "deleted_at": deleted_at.isoformat(),
            "reason": reason,
        }
        self._deleted_sandboxes.insert(0, deleted_info)
        # Keep only the last N deleted sandboxes
        self._deleted_sandboxes = self._deleted_sandboxes[:self._max_deleted_sandboxes]

        # Log deletion to orchestrator
        self._log_orchestrator(f"Deleting sandbox {run_id_str[:8]} ({runtime.game.value}) - reason: {reason}")

        try:
            if runtime.sandbox:
                runtime.sandbox.delete()
                self._log_orchestrator(f"Sandbox {run_id_str[:8]} DO app deleted successfully")
        except Exception as e:
            self._log_orchestrator(f"Sandbox {run_id_str[:8]} deletion error: {e}", level="warning")

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

    def get_runtime(self, run_id: UUID) -> Optional[SandboxRuntime]:
        """Get sandbox runtime by run ID (includes service token for proxying)."""
        return self._active_sandboxes.get(str(run_id))

    def get_active_sandboxes(self) -> list[SandboxInfo]:
        """Get all active sandboxes."""
        return [runtime.to_info() for runtime in self._active_sandboxes.values()]

    def get_deleted_sandboxes(self, limit: int = 10) -> list[dict]:
        """Get recently deleted sandboxes history."""
        return self._deleted_sandboxes[:limit]

    async def cleanup_expired(self) -> int:
        """Delete expired sandboxes. Returns count of deleted."""
        now = datetime.utcnow()
        expired = []

        for run_id, runtime in self._active_sandboxes.items():
            if runtime.expires_at and runtime.expires_at <= now:
                expired.append((UUID(run_id), runtime.game.value))

        if expired:
            self._log_orchestrator(f"Auto-cleanup: {len(expired)} sandbox(es) expired")

        for run_id, game in expired:
            await self.delete(run_id, reason=f"expired (auto-cleanup after {config.SANDBOX_MIN_LIFETIME_MINUTES}-{config.SANDBOX_MAX_LIFETIME_MINUTES} min)")

        return len(expired)


# Global service instance (renamed from cold_service for backwards compatibility)
sandbox_service = SandboxService()
cold_service = sandbox_service  # Alias for backwards compatibility
