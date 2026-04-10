#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Litas-dev/Kivana-server.git}"
BASE_DIR="${BASE_DIR:-/opt/kivana}"
REPO_DIR="${REPO_DIR:-$BASE_DIR/Kivana-server}"
API_DIR="$REPO_DIR/kivana-api"

apt-get update -y
apt-get install -y ca-certificates curl git

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${VERSION_CODENAME}) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

mkdir -p "$BASE_DIR"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "$REPO_URL" "$REPO_DIR"
fi

cd "$API_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
fi

docker compose up -d --build
curl -fsS http://localhost:8080/healthz >/dev/null
echo "OK"
