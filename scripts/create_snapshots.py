#!/usr/bin/env python3
"""
Create and upload game snapshots to DigitalOcean Spaces.

This script:
1. Clones the do-sandbox-games repo
2. Creates tar.gz archives for each game
3. Uploads them to Spaces

For production use, you'd want to create snapshots from running sandboxes
that have dependencies already installed.
"""

import os
import subprocess
import tarfile
import tempfile
from pathlib import Path

import boto3
from botocore.client import Config
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

GAMES_REPO = "https://github.com/bikramkgupta/do-sandbox-games.git"

GAMES = {
    "snake": "snake-python",
    "tic-tac-toe": "tictactoe-node",
    "memory": "memory-python",
}

def get_spaces_client():
    """Create S3 client for DigitalOcean Spaces."""
    return boto3.client(
        "s3",
        region_name=os.getenv("SPACES_REGION", "syd1"),
        endpoint_url=f"https://{os.getenv('SPACES_REGION', 'syd1')}.digitaloceanspaces.com",
        aws_access_key_id=os.getenv("SPACES_ACCESS_KEY"),
        aws_secret_access_key=os.getenv("SPACES_SECRET_KEY"),
        config=Config(signature_version="s3v4"),
    )


def create_snapshot(game_dir: Path, snapshot_name: str, output_dir: Path) -> Path:
    """Create a tar.gz snapshot of a game directory."""
    snapshot_path = output_dir / f"{snapshot_name}.tar.gz"

    print(f"Creating snapshot: {snapshot_path}")

    with tarfile.open(snapshot_path, "w:gz") as tar:
        # Add the game directory contents to the archive
        tar.add(game_dir, arcname=game_dir.name)

    print(f"  Size: {snapshot_path.stat().st_size / 1024:.1f} KB")
    return snapshot_path


def upload_to_spaces(filepath: Path, bucket: str, key: str):
    """Upload a file to Spaces."""
    client = get_spaces_client()

    print(f"Uploading to s3://{bucket}/{key}")

    client.upload_file(
        str(filepath),
        bucket,
        key,
        ExtraArgs={"ACL": "public-read"},
    )

    url = f"https://{bucket}.{os.getenv('SPACES_REGION', 'syd1')}.digitaloceanspaces.com/{key}"
    print(f"  URL: {url}")
    return url


def main():
    """Main entry point."""
    bucket = os.getenv("SPACES_BUCKET")
    if not bucket:
        print("Error: SPACES_BUCKET not set")
        return

    if not os.getenv("SPACES_ACCESS_KEY"):
        print("Error: SPACES_ACCESS_KEY not set")
        return

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Clone the games repository
        print(f"Cloning {GAMES_REPO}...")
        subprocess.run(
            ["git", "clone", "--depth", "1", GAMES_REPO, str(tmpdir / "games")],
            check=True,
        )

        games_dir = tmpdir / "games"
        snapshots_dir = tmpdir / "snapshots"
        snapshots_dir.mkdir()

        # Create and upload snapshots for each game
        for game_folder, snapshot_name in GAMES.items():
            game_path = games_dir / game_folder
            if not game_path.exists():
                print(f"Warning: {game_folder} not found, skipping")
                continue

            # Create snapshot
            snapshot_path = create_snapshot(game_path, snapshot_name, snapshots_dir)

            # Upload to Spaces
            upload_to_spaces(
                snapshot_path,
                bucket,
                f"snapshots/{snapshot_name}.tar.gz",
            )
            print()

    print("Done! Snapshots uploaded to Spaces.")


if __name__ == "__main__":
    main()
