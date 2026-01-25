#!/usr/bin/env python3
"""
Create and upload game snapshots to DigitalOcean Spaces.

This script:
1. Clones the do-sandbox-games repo
2. Installs Python dependencies into each game directory
3. Creates tar.gz archives for each game (including dependencies)
4. Uploads them to Spaces

Snapshots include installed dependencies, so sandbox deployment
only needs to extract and run - no pip install required.
"""

import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

import boto3
from botocore.client import Config
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

GAMES_REPO = "https://github.com/bikramkgupta/do-sandbox-games.git"

# Game configurations: folder name -> (snapshot name, runtime type)
# runtime type: "python" or "node"
GAMES = {
    "snake": ("snake-python", "python"),
    "tic-tac-toe-python": ("tictactoe-python", "python"),
    "memory": ("memory-python", "python"),
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


def install_python_deps(game_dir: Path) -> bool:
    """Install Python dependencies into the game directory.

    Uses pip install --target to install packages directly into the game folder.
    This makes the snapshot self-contained - no pip install needed at runtime.
    """
    requirements_file = game_dir / "requirements.txt"
    if not requirements_file.exists():
        print(f"  No requirements.txt found, skipping dependency install")
        return True

    print(f"  Installing Python dependencies from {requirements_file.name}...")

    # Install packages directly into the game directory
    # Using --target installs packages to the specified directory
    # The sandbox will find them because we run from this directory
    result = subprocess.run(
        [
            sys.executable, "-m", "pip", "install",
            "--target", str(game_dir),
            "-r", str(requirements_file),
            "--quiet",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"  Warning: pip install failed: {result.stderr}")
        return False

    # Count installed packages
    installed = list(game_dir.glob("*.dist-info"))
    print(f"  Installed {len(installed)} packages into game directory")
    return True


def install_node_deps(game_dir: Path) -> bool:
    """Install Node.js dependencies into the game directory.

    Runs npm install to create node_modules in the game folder.
    """
    package_json = game_dir / "package.json"
    if not package_json.exists():
        print(f"  No package.json found, skipping dependency install")
        return True

    print(f"  Installing Node.js dependencies...")

    result = subprocess.run(
        ["npm", "install", "--production", "--silent"],
        cwd=game_dir,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"  Warning: npm install failed: {result.stderr}")
        return False

    node_modules = game_dir / "node_modules"
    if node_modules.exists():
        pkg_count = len(list(node_modules.iterdir()))
        print(f"  Installed {pkg_count} packages into node_modules")
    return True


def create_snapshot(game_dir: Path, snapshot_name: str, output_dir: Path) -> Path:
    """Create a tar.gz snapshot of a game directory (including dependencies)."""
    snapshot_path = output_dir / f"{snapshot_name}.tar.gz"

    print(f"Creating snapshot: {snapshot_path}")

    with tarfile.open(snapshot_path, "w:gz") as tar:
        # Add the game directory contents to the archive
        tar.add(game_dir, arcname=game_dir.name)

    size_kb = snapshot_path.stat().st_size / 1024
    if size_kb > 1024:
        print(f"  Size: {size_kb / 1024:.1f} MB")
    else:
        print(f"  Size: {size_kb:.1f} KB")
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
        for game_folder, (snapshot_name, runtime_type) in GAMES.items():
            print(f"\n{'='*50}")
            print(f"Processing: {game_folder} ({runtime_type})")
            print(f"{'='*50}")

            game_path = games_dir / game_folder
            if not game_path.exists():
                print(f"Warning: {game_folder} not found, skipping")
                continue

            # Install dependencies based on runtime type
            if runtime_type == "python":
                if not install_python_deps(game_path):
                    print(f"Warning: Failed to install Python deps for {game_folder}")
            elif runtime_type == "node":
                if not install_node_deps(game_path):
                    print(f"Warning: Failed to install Node deps for {game_folder}")

            # Create snapshot (now includes dependencies)
            snapshot_path = create_snapshot(game_path, snapshot_name, snapshots_dir)

            # Upload to Spaces
            upload_to_spaces(
                snapshot_path,
                bucket,
                f"snapshots/{snapshot_name}.tar.gz",
            )

    print("\n" + "="*50)
    print("Done! Snapshots with dependencies uploaded to Spaces.")
    print("="*50)


if __name__ == "__main__":
    main()
