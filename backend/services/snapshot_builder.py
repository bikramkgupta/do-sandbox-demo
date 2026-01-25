"""Build game snapshots inside a sandbox for correct architecture."""
import asyncio
import logging
from typing import Optional

from do_app_sandbox import Sandbox, SandboxMode
from do_app_sandbox.exceptions import ServiceConnectionError

from config import config

logger = logging.getLogger(__name__)

# Games to build snapshots for: (folder_name, snapshot_name)
GAMES = [
    ("snake", "snake-python"),
    ("memory", "memory-python"),
    ("tic-tac-toe-python", "tictactoe-python"),
]

GAMES_REPO = "https://github.com/bikramkgupta/do-sandbox-games.git"


async def exec_in_sandbox(
    sandbox: Sandbox,
    command: str,
    timeout: int = 120,
    max_retries: int = 5,
    retry_delay: int = 5,
) -> tuple[bool, str]:
    """Execute command in sandbox with retry, return (success, output)."""
    last_error: Optional[Exception] = None
    for attempt in range(max_retries):
        try:
            result = await asyncio.to_thread(sandbox.exec, command, timeout=timeout)
            return result.success, result.stdout if result.success else result.stderr
        except (ServiceConnectionError, Exception) as e:
            last_error = e
            error_msg = str(e)
            retryable = (
                "Name or service not known" in error_msg
                or "Failed to connect to sandbox" in error_msg
                or "Connection" in error_msg
            )
            if retryable and attempt < max_retries - 1:
                logger.warning(
                    "Sandbox exec failed (%s), retrying in %ss (attempt %s/%s)",
                    error_msg,
                    retry_delay,
                    attempt + 1,
                    max_retries,
                )
                await asyncio.sleep(retry_delay)
                continue
            return False, error_msg
    return False, str(last_error) if last_error else "Unknown error"


async def build_snapshots_in_sandbox() -> bool:
    """
    Build game snapshots inside a sandbox to ensure correct architecture.

    This creates a temporary sandbox, installs dependencies for each game,
    creates tar.gz archives, and uploads them to Spaces.

    Returns True if all snapshots built successfully.
    """
    if not config.SPACES_BUCKET or not config.SPACES_ACCESS_KEY:
        logger.error("Spaces credentials not configured, skipping snapshot build")
        return False

    logger.info("="*60)
    logger.info("SNAPSHOT BUILDER: Starting snapshot build in sandbox")
    logger.info("="*60)

    sandbox: Optional[Sandbox] = None
    all_success = True

    try:
        # Create a sandbox for building
        logger.info("Creating builder sandbox...")
        sandbox = Sandbox.create(
            image="python",
            api_token=config.DIGITALOCEAN_TOKEN,
            mode=SandboxMode.SERVICE,
            wait_ready=True,
            timeout=180,
        )
        logger.info(f"Builder sandbox created: {sandbox.app_id}")

        # Install awscli for S3 uploads (DO Spaces is S3-compatible)
        logger.info("Installing awscli for Spaces uploads...")
        success, output = await exec_in_sandbox(
            sandbox,
            "pip install awscli --quiet",
            timeout=60
        )
        if not success:
            logger.error(f"Failed to install awscli: {output}")
            return False

        # Configure AWS CLI for DO Spaces
        spaces_endpoint = f"https://{config.SPACES_REGION}.digitaloceanspaces.com"
        aws_config_cmds = f"""
mkdir -p ~/.aws && \
echo '[default]
aws_access_key_id = {config.SPACES_ACCESS_KEY}
aws_secret_access_key = {config.SPACES_SECRET_KEY}
' > ~/.aws/credentials && \
echo '[default]
region = {config.SPACES_REGION}
' > ~/.aws/config
"""
        success, output = await exec_in_sandbox(sandbox, aws_config_cmds, timeout=30)
        if not success:
            logger.error(f"Failed to configure AWS CLI: {output}")
            return False
        logger.info("AWS CLI configured for Spaces")

        # Clone games repository
        logger.info(f"Cloning games repository: {GAMES_REPO}")
        success, output = await exec_in_sandbox(
            sandbox,
            f"git clone --depth 1 {GAMES_REPO} /workspace/games",
            timeout=60
        )
        if not success:
            logger.error(f"Failed to clone games repo: {output}")
            return False
        logger.info("Games repository cloned")

        # Build each game snapshot
        for folder, snapshot_name in GAMES:
            logger.info(f"\n{'='*40}")
            logger.info(f"Building snapshot: {snapshot_name}")
            logger.info(f"{'='*40}")

            game_path = f"/workspace/games/{folder}"

            # Check if game exists
            success, _ = await exec_in_sandbox(sandbox, f"test -d {game_path}")
            if not success:
                logger.warning(f"Game folder not found: {folder}, skipping")
                continue

            # Install dependencies into game directory
            logger.info(f"Installing dependencies for {folder}...")
            success, output = await exec_in_sandbox(
                sandbox,
                f"pip install --target={game_path} -r {game_path}/requirements.txt --quiet",
                timeout=120
            )
            if not success:
                logger.warning(f"Dependency install warning for {folder}: {output}")
                # Continue anyway - some games might not have requirements.txt

            # Count installed packages
            success, output = await exec_in_sandbox(
                sandbox,
                f"ls -1 {game_path}/*.dist-info 2>/dev/null | wc -l"
            )
            pkg_count = output.strip() if success else "?"
            logger.info(f"Installed {pkg_count} packages for {folder}")

            # Create tarball
            logger.info(f"Creating tarball: {snapshot_name}.tar.gz")
            success, output = await exec_in_sandbox(
                sandbox,
                f"cd /workspace/games && tar -czf /tmp/{snapshot_name}.tar.gz {folder}",
                timeout=60
            )
            if not success:
                logger.error(f"Failed to create tarball for {folder}: {output}")
                all_success = False
                continue

            # Get tarball size
            success, output = await exec_in_sandbox(
                sandbox,
                f"du -h /tmp/{snapshot_name}.tar.gz | cut -f1"
            )
            size = output.strip() if success else "?"
            logger.info(f"Tarball size: {size}")

            # Upload to Spaces
            logger.info(f"Uploading to Spaces: snapshots/{snapshot_name}.tar.gz")
            upload_cmd = (
                f"aws s3 cp /tmp/{snapshot_name}.tar.gz "
                f"s3://{config.SPACES_BUCKET}/snapshots/{snapshot_name}.tar.gz "
                f"--endpoint-url {spaces_endpoint} "
                f"--acl public-read"
            )
            success, output = await exec_in_sandbox(sandbox, upload_cmd, timeout=120)
            if not success:
                logger.error(f"Failed to upload {snapshot_name}: {output}")
                all_success = False
                continue

            logger.info(f"Successfully uploaded {snapshot_name}")

        logger.info("\n" + "="*60)
        if all_success:
            logger.info("SNAPSHOT BUILDER: All snapshots built and uploaded successfully!")
        else:
            logger.warning("SNAPSHOT BUILDER: Completed with some failures")
        logger.info("="*60)

        return all_success

    except Exception as e:
        logger.error(f"Snapshot build failed with exception: {e}", exc_info=True)
        return False

    finally:
        # Always clean up the builder sandbox
        if sandbox:
            try:
                logger.info(f"Cleaning up builder sandbox: {sandbox.app_id}")
                sandbox.delete()
                logger.info("Builder sandbox deleted")
            except Exception as e:
                logger.warning(f"Failed to delete builder sandbox: {e}")
