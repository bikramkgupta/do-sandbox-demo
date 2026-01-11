"""Configuration from environment variables."""
import os
from dataclasses import dataclass, field
from pathlib import Path
from dotenv import load_dotenv

# Load .env from project root
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(env_path)


@dataclass
class Config:
    # DigitalOcean
    DIGITALOCEAN_TOKEN: str = os.getenv("DIGITALOCEAN_TOKEN", "")

    # Spaces for snapshots
    SPACES_BUCKET: str = os.getenv("SPACES_BUCKET", "")
    SPACES_REGION: str = os.getenv("SPACES_REGION", "")
    SPACES_ACCESS_KEY: str = os.getenv("SPACES_ACCESS_KEY", "")
    SPACES_SECRET_KEY: str = os.getenv("SPACES_SECRET_KEY", "")

    # Database
    DATABASE_URL: str = os.getenv("DATABASE_URL", "postgresql://localhost/sandbox_demo")

    # Rate Limiting (CRITICAL - strictly enforced)
    MAX_CONCURRENT_COLD: int = int(os.getenv("MAX_CONCURRENT_COLD", "2"))
    MAX_CONCURRENT_WARM: int = int(os.getenv("MAX_CONCURRENT_WARM", "2"))
    MAX_TOTAL_ACTIVE: int = int(os.getenv("MAX_TOTAL_ACTIVE", "6"))
    MAX_RUNS_PER_HOUR: int = int(os.getenv("MAX_RUNS_PER_HOUR", "10"))

    # Sandbox settings
    SANDBOX_MIN_LIFETIME_MINUTES: int = int(os.getenv("SANDBOX_MIN_LIFETIME_MINUTES", "3"))
    SANDBOX_MAX_LIFETIME_MINUTES: int = int(os.getenv("SANDBOX_MAX_LIFETIME_MINUTES", "6"))
    CLEANUP_INTERVAL_SECONDS: int = int(os.getenv("CLEANUP_INTERVAL_SECONDS", "30"))

    # Warm pool settings
    WARM_POOL_TARGET_READY: int = int(os.getenv("WARM_POOL_TARGET_READY", "2"))
    WARM_POOL_MAX_READY: int = int(os.getenv("WARM_POOL_MAX_READY", "4"))

    # Available games
    AVAILABLE_GAMES: list = field(default_factory=lambda: ["snake", "tic-tac-toe", "memory"])

    def validate(self) -> list[str]:
        """Validate required configuration. Returns list of missing vars."""
        missing = []
        if not self.DIGITALOCEAN_TOKEN:
            missing.append("DIGITALOCEAN_TOKEN")
        return missing


config = Config()
