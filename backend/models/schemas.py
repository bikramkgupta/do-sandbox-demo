"""Pydantic models for API requests and responses."""
from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class SandboxType(str, Enum):
    COLD = "cold"
    WARM = "warm"
    SNAPSHOT = "snapshot"


class GameType(str, Enum):
    SNAKE = "snake"
    TIC_TAC_TOE = "tic-tac-toe"
    MEMORY = "memory"


class SandboxStatus(str, Enum):
    CREATING = "creating"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class TriggeredBy(str, Enum):
    USER = "user"
    SCHEDULER = "scheduler"


# Request models
class LaunchRequest(BaseModel):
    game: GameType = Field(default=GameType.SNAKE, description="Game to run in sandbox")
    use_snapshot: bool = Field(default=True, description="Use snapshot (fast) or clone from GitHub (slow)")


# Response models
class LaunchResponse(BaseModel):
    run_id: UUID
    stream_url: str
    message: str


class SandboxInfo(BaseModel):
    run_id: UUID
    type: SandboxType
    game: GameType
    status: SandboxStatus
    app_id: Optional[str] = None
    ingress_url: Optional[str] = None
    bootstrap_ms: Optional[int] = None
    acquire_ms: Optional[int] = None
    restore_ms: Optional[int] = None
    duration_ms: Optional[int] = None
    created_at: datetime
    expires_at: Optional[datetime] = None


class PoolStatus(BaseModel):
    ready: int
    creating: int
    in_use: int


class RateStatus(BaseModel):
    used: int
    limit: int
    reset_in_seconds: int


class ActiveSandboxes(BaseModel):
    cold: int
    warm: int
    snapshot: int
    total: int


class StatusResponse(BaseModel):
    active: list[SandboxInfo]
    active_counts: ActiveSandboxes
    pool: PoolStatus
    rate: RateStatus


class HistoryItem(BaseModel):
    run_id: UUID
    type: SandboxType
    game: GameType
    status: SandboxStatus
    bootstrap_ms: Optional[int] = None
    acquire_ms: Optional[int] = None
    restore_ms: Optional[int] = None
    duration_ms: Optional[int] = None
    triggered_by: TriggeredBy
    created_at: datetime
    completed_at: Optional[datetime] = None


class StatsResponse(BaseModel):
    total_runs: int
    by_type: dict[str, int]
    avg_times: dict[str, Optional[float]]
    pool_hit_rate: float


class ErrorResponse(BaseModel):
    error: str
    detail: Optional[str] = None


# SSE event models
class LogEvent(BaseModel):
    type: str = "log"
    run_id: UUID
    message: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class StatusEvent(BaseModel):
    type: str = "status"
    run_id: UUID
    status: SandboxStatus
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class ReadyEvent(BaseModel):
    type: str = "ready"
    run_id: UUID
    ingress_url: str
    bootstrap_ms: int
    restore_ms: Optional[int] = None
    total_ms: int
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class CompleteEvent(BaseModel):
    type: str = "complete"
    run_id: UUID
    duration_ms: int
    timestamp: datetime = Field(default_factory=datetime.utcnow)
