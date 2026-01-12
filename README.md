# DO App Sandbox Demo

Interactive demo showcasing DigitalOcean App Platform Sandbox capabilities - comparing Cold Start vs Warm Pool sandbox provisioning with optional snapshot restoration.

## Features

- **Cold Start vs Warm Pool Comparison**: Side-by-side view of sandbox provisioning speeds
- **Snapshot Toggle**: Switch between restoring from Spaces snapshots (~faster) or cloning from GitHub (~slower)
- **Live Logs**: Real-time SSE streaming of sandbox creation progress
- **Rate Limiting**: Built-in protection (max 2 cold, max 2 warm, max 10/hour)
- **Auto-cleanup**: Sandboxes automatically deleted after 3-6 minutes
- **Mini Games**: Snake, Tic-Tac-Toe, and Memory games to demonstrate real applications

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Next.js 14     │────▶│  FastAPI        │────▶│  DO App         │
│  Frontend       │     │  Backend        │     │  Sandbox        │
│  (Port 3000)    │◀────│  (Port 8000)    │◀────│  SDK            │
└─────────────────┘ SSE └─────────────────┘     └─────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  PostgreSQL     │
                    │  (History/Stats)│
                    └─────────────────┘
```

## Time Breakdown

| Mode | Snapshot ON | Snapshot OFF |
|------|-------------|--------------|
| Cold Start | ~40s (30s sandbox + 10s restore) | ~90s (30s sandbox + 60s build) |
| Warm Pool | ~10s (50ms acquire + 10s restore) | ~60s (50ms acquire + 60s build) |

## Quick Start

1. **Set up environment variables**:
   ```bash
   cp .env.example .env
   # Edit .env with your DigitalOcean credentials
   ```

2. **Run with Docker Compose**:
   ```bash
   docker-compose up --build
   ```

3. **Open the demo**:
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:8000

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DIGITALOCEAN_TOKEN` | DigitalOcean API token with sandbox permissions |
| `SPACES_BUCKET` | Spaces bucket name for snapshots |
| `SPACES_REGION` | Spaces region (e.g., `syd1`) |
| `SPACES_ACCESS_KEY` | Spaces access key |
| `SPACES_SECRET_KEY` | Spaces secret key |

## Game Source Code

Games are hosted at: https://github.com/bikramkgupta/do-sandbox-games

## Creating Snapshots

To create/update snapshots in Spaces:

```bash
python scripts/create_snapshots.py
```

This clones the games repo and uploads tar.gz archives to your Spaces bucket.

## API Endpoints

- `POST /api/launch/cold` - Launch a cold sandbox
- `POST /api/launch/warm` - Launch from warm pool
- `GET /api/stream/{run_id}` - SSE stream for sandbox events
- `GET /api/status` - Get current system status
- `DELETE /api/sandbox/{run_id}` - Delete a sandbox
- `GET /api/limits` - Get rate limit status

## Tech Stack

- **Frontend**: Next.js 14, TypeScript, Tailwind CSS
- **Backend**: FastAPI, Python 3.12, SSE-Starlette
- **Database**: PostgreSQL 16
- **SDK**: do-app-sandbox (>=0.2.1)

## Deployment

### GitHub Actions (Recommended)

Deployment is automated via GitHub Actions. Push to `main` or trigger manually:

1. **Automatic**: Push to `main` branch triggers deployment
2. **Manual**: Go to Actions → "Deploy to App Platform" → "Run workflow"

### Required GitHub Secrets

Configure these in your repository settings (Settings → Secrets and variables → Actions):

| Secret | Description |
|--------|-------------|
| `DIGITALOCEAN_ACCESS_TOKEN` | DO API token for deployment |
| `DIGITALOCEAN_TOKEN` | DO API token for sandbox SDK |
| `SPACES_BUCKET` | Spaces bucket name |
| `SPACES_REGION` | Spaces region (e.g., `syd1`) |
| `SPACES_ACCESS_KEY` | Spaces access key |
| `SPACES_SECRET_KEY` | Spaces secret key |

### Manual Deployment

```bash
# Create deployment (uses .do/app.yaml)
doctl apps create-deployment <APP_ID>

# Or update app spec and deploy
doctl apps update <APP_ID> --spec .do/app.yaml
```

### App Configuration

The app spec is located at `.do/app.yaml`. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `WARM_POOL_ENABLED` | `true` | Enable/disable warm sandbox pool |
| `WARM_POOL_TARGET_READY` | `2` | Target sandboxes in pool |
| `WARM_POOL_MAX_READY` | `3` | Maximum sandboxes in pool |
| `MAX_CONCURRENT_COLD` | `3` | Max concurrent cold starts |
| `MAX_RUNS_PER_HOUR` | `25` | Rate limit per hour |

## License

MIT
