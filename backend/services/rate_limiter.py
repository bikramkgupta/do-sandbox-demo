"""Rate limiting service - CRITICAL for safety.

Enforces:
- Max concurrent cold sandboxes (default: 2)
- Max concurrent warm sandboxes (default: 2)
- Max total active sandboxes (default: 6)
- Max runs per hour (default: 10)
"""
from datetime import datetime, timedelta
from typing import Optional
import asyncio

from config import config


class RateLimitError(Exception):
    """Raised when rate limit is exceeded."""
    pass


class RateLimiter:
    """In-memory rate limiter. For production, use Redis or database."""

    def __init__(self):
        self._active_cold: set[str] = set()  # run_ids
        self._active_warm: set[str] = set()
        self._active_snapshot: set[str] = set()
        self._hourly_counts: dict[str, int] = {}  # hour_key -> count
        self._lock = asyncio.Lock()

    def _get_hour_key(self) -> str:
        """Get current hour key for rate limiting."""
        now = datetime.utcnow()
        return now.strftime("%Y-%m-%d-%H")

    def _get_seconds_until_reset(self) -> int:
        """Get seconds until current rate limit window resets."""
        now = datetime.utcnow()
        next_hour = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
        return int((next_hour - now).total_seconds())

    async def can_launch(self, sandbox_type: str) -> tuple[bool, Optional[str]]:
        """
        Check if a new sandbox can be launched.

        Returns: (can_launch, error_message)
        """
        async with self._lock:
            # 1. Check hourly rate limit
            hour_key = self._get_hour_key()
            hourly_count = self._hourly_counts.get(hour_key, 0)
            if hourly_count >= config.MAX_RUNS_PER_HOUR:
                reset_in = self._get_seconds_until_reset()
                return False, f"Rate limit exceeded: {hourly_count}/{config.MAX_RUNS_PER_HOUR} runs this hour. Resets in {reset_in}s"

            # 2. Check total active
            total_active = len(self._active_cold) + len(self._active_warm) + len(self._active_snapshot)
            if total_active >= config.MAX_TOTAL_ACTIVE:
                return False, f"Max active sandboxes reached: {total_active}/{config.MAX_TOTAL_ACTIVE}"

            # 3. Check type-specific limit
            if sandbox_type == "cold":
                if len(self._active_cold) >= config.MAX_CONCURRENT_COLD:
                    return False, f"Max cold sandboxes reached: {len(self._active_cold)}/{config.MAX_CONCURRENT_COLD}"
            elif sandbox_type == "warm":
                if len(self._active_warm) >= config.MAX_CONCURRENT_WARM:
                    return False, f"Max warm sandboxes reached: {len(self._active_warm)}/{config.MAX_CONCURRENT_WARM}"
            elif sandbox_type == "snapshot":
                # Snapshots share the warm limit
                if len(self._active_snapshot) >= config.MAX_CONCURRENT_WARM:
                    return False, f"Max snapshot sandboxes reached: {len(self._active_snapshot)}/{config.MAX_CONCURRENT_WARM}"

            return True, None

    async def register_launch(self, run_id: str, sandbox_type: str) -> None:
        """Register a new sandbox launch."""
        async with self._lock:
            # Add to active set
            if sandbox_type == "cold":
                self._active_cold.add(run_id)
            elif sandbox_type == "warm":
                self._active_warm.add(run_id)
            elif sandbox_type == "snapshot":
                self._active_snapshot.add(run_id)

            # Increment hourly count
            hour_key = self._get_hour_key()
            self._hourly_counts[hour_key] = self._hourly_counts.get(hour_key, 0) + 1

            # Clean up old hour keys
            current_hour = self._get_hour_key()
            self._hourly_counts = {
                k: v for k, v in self._hourly_counts.items()
                if k >= (datetime.utcnow() - timedelta(hours=2)).strftime("%Y-%m-%d-%H")
            }

    async def unregister_sandbox(self, run_id: str) -> None:
        """Remove a sandbox from active tracking."""
        async with self._lock:
            self._active_cold.discard(run_id)
            self._active_warm.discard(run_id)
            self._active_snapshot.discard(run_id)

    async def get_status(self) -> dict:
        """Get current rate limit status."""
        async with self._lock:
            hour_key = self._get_hour_key()
            hourly_count = self._hourly_counts.get(hour_key, 0)

            return {
                "active": {
                    "cold": len(self._active_cold),
                    "warm": len(self._active_warm),
                    "snapshot": len(self._active_snapshot),
                    "total": len(self._active_cold) + len(self._active_warm) + len(self._active_snapshot),
                },
                "rate": {
                    "used": hourly_count,
                    "limit": config.MAX_RUNS_PER_HOUR,
                    "reset_in_seconds": self._get_seconds_until_reset(),
                },
                "limits": {
                    "max_cold": config.MAX_CONCURRENT_COLD,
                    "max_warm": config.MAX_CONCURRENT_WARM,
                    "max_total": config.MAX_TOTAL_ACTIVE,
                    "max_per_hour": config.MAX_RUNS_PER_HOUR,
                },
            }

    async def get_active_run_ids(self) -> list[str]:
        """Get all active run IDs."""
        async with self._lock:
            return list(self._active_cold | self._active_warm | self._active_snapshot)


# Global rate limiter instance
rate_limiter = RateLimiter()
