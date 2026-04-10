#!/usr/bin/env bash
set -euo pipefail

C_BLUE='\033[1;34m'
C_CYAN='\033[1;36m'
C_GREEN='\033[1;32m'
C_PURPLE='\033[1;35m'
C_YELLOW='\033[1;33m'
C_RED='\033[1;31m'
C_RESET='\033[0m'
C_BOLD='\033[1m'

info() { echo -e "${C_CYAN}[i]${C_RESET} $1"; }
success() { echo -e "${C_GREEN}[✓]${C_RESET} $1"; }
error() { echo -e "${C_RED}[✗]${C_RESET} $1"; }
warn() { echo -e "${C_YELLOW}[!]${C_RESET} $1"; }

if [ "${EUID:-0}" -ne 0 ]; then
  error "Run as root: sudo -i"
  exit 1
fi

REPO_URL_DEFAULT="https://github.com/Litas-dev/Kivana-server.git"
BASE_DIR_DEFAULT="/opt/kivana"
REPO_DIR_DEFAULT="${BASE_DIR_DEFAULT}/Kivana-server"
API_DIR_DEFAULT="${REPO_DIR_DEFAULT}/kivana-api"

REPO_URL="$REPO_URL_DEFAULT"
BASE_DIR="$BASE_DIR_DEFAULT"
HTTP_PORT="8080"
POSTGRES_PASSWORD=""
JWT_SECRET=""
ADMIN_TOKEN=""

prompt() {
  local label="${C_PURPLE}[?]${C_RESET} $1"
  local def="${2:-}"
  local v
  if [ -n "$def" ]; then
    if [ -r /dev/tty ]; then
      read -r -p "$(echo -e "${label} [${C_BOLD}${def}${C_RESET}]: ")" v </dev/tty || v=""
    else
      read -r -p "$(echo -e "${label} [${C_BOLD}${def}${C_RESET}]: ")" v || v=""
    fi
    if [ -z "$v" ]; then v="$def"; fi
  else
    if [ -r /dev/tty ]; then
      read -r -p "$(echo -e "${label}: ")" v </dev/tty || v=""
    else
      read -r -p "$(echo -e "${label}: ")" v || v=""
    fi
  fi
  printf "%s" "$v"
}

confirm() {
  local label="${C_PURPLE}[?]${C_RESET} $1"
  local def="${2:-y}"
  local v
  while true; do
    if [ "$def" = "y" ]; then
      if [ -r /dev/tty ]; then
        read -r -p "$(echo -e "${label} [${C_BOLD}Y${C_RESET}/n]: ")" v </dev/tty || v=""
      else
        read -r -p "$(echo -e "${label} [${C_BOLD}Y${C_RESET}/n]: ")" v || v=""
      fi
      v="${v:-y}"
    else
      if [ -r /dev/tty ]; then
        read -r -p "$(echo -e "${label} [y/${C_BOLD}N${C_RESET}]: ")" v </dev/tty || v=""
      else
        read -r -p "$(echo -e "${label} [y/${C_BOLD}N${C_RESET}]: ")" v || v=""
      fi
      v="${v:-n}"
    fi
    case "$v" in
      y|Y) return 0 ;;
      n|N) return 1 ;;
    esac
  done
}

rand_hex() {
  local nbytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$nbytes"
  else
    head -c "$nbytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

banner() {
  echo -e "${C_CYAN}"
  echo '    _  __ _                             '
  echo '   | |/ /(_)__   __ __ _  _ __    __ _  '
  echo '   | '\'' / | |\ \ / // _` || '\''_ \  / _` | '
  echo '   | . \ | | \ V /| (_| || | | || (_| | '
  echo '   |_|\_\|_|  \_/  \__,_||_| |_| \__,_| '
  echo -e "${C_RESET}"
  echo -e "   ${C_BOLD}Server Edition${C_RESET} ${C_PURPLE}v0.2.2${C_RESET}"
  echo
}

banner

if [ -r /dev/tty ]; then
  info "Starting interactive setup..."
  REPO_URL="$(prompt "GitHub repo URL" "$REPO_URL_DEFAULT")"
  BASE_DIR="$(prompt "Install base dir" "$BASE_DIR_DEFAULT")"
  HTTP_PORT="$(prompt "HTTP port" "8080")"

  POSTGRES_PASSWORD="$(prompt "Postgres password (leave blank to auto-generate)" "")"
  JWT_SECRET="$(prompt "JWT secret (leave blank to auto-generate)" "")"
  ADMIN_TOKEN="$(prompt "Admin token (leave blank to auto-generate)" "")"
else
  warn "No TTY detected. Using defaults (non-interactive)."
  info "Tip: run without piping for prompts: curl -fsSLO <url> && bash setup-wizard.sh"
fi

if [ -z "$POSTGRES_PASSWORD" ]; then
  POSTGRES_PASSWORD="$(rand_hex 24)"
  success "Generated Postgres password."
fi

if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET="$(rand_hex 48)"
  success "Generated JWT secret."
fi

if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN="$(rand_hex 24)"
  success "Generated admin token."
fi

REPO_DIR="${BASE_DIR}/Kivana-server"
API_DIR="${REPO_DIR}/kivana-api"

if ! command -v git >/dev/null 2>&1; then
  if confirm "Install git now?" y; then
    apt-get update -y
    apt-get install -y git
  else
    error "git is required."
    exit 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker not found."
  if confirm "Install Docker + Compose?" y; then
    info "Installing Docker..."
    apt-get update -y
    apt-get install -y ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${VERSION_CODENAME}) stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    success "Docker installed."
  else
    error "Docker is required for the easy deploy."
    exit 1
  fi
fi

mkdir -p "$BASE_DIR"
if [ -d "$REPO_DIR/.git" ]; then
  cd "$REPO_DIR"
  if confirm "Repo exists. Pull latest changes?" y; then
    info "Pulling latest changes..."
    git pull
    success "Updated."
  fi
else
  info "Cloning repo..."
  git clone "$REPO_URL" "$REPO_DIR"
  success "Cloned."
fi

cd "$API_DIR"

info "Writing .env file..."
if [ -f .env ]; then
  if confirm ".env exists. Overwrite it?" y; then
    :
  else
    warn "Keeping existing .env"
  fi
fi

if [ ! -f .env ] || confirm "Write/update .env now?" y; then
  cat > .env <<EOF
DATABASE_URL=postgres://kivana:${POSTGRES_PASSWORD}@db:5432/kivana
JWT_SECRET=${JWT_SECRET}
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
BIND_ADDR=0.0.0.0:8080
ADMIN_TOKEN=${ADMIN_TOKEN}
RUST_LOG=info
KIVANA_HTTP_PORT=${HTTP_PORT}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
EOF
  chmod 600 .env || true
  success ".env written"
fi

echo
info "Starting containers..."
docker compose up -d --build

info "Waiting for health..."
ok="n"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${HTTP_PORT}/healthz" >/dev/null 2>&1; then
    ok="y"
    break
  fi
  sleep 1
done

if [ "$ok" != "y" ]; then
  error "Health check did not pass yet. Showing logs:"
  docker compose logs --tail=200 api
  exit 1
fi
success "Server is healthy!"

PUBLIC_IP=""
if command -v curl >/dev/null 2>&1; then
  PUBLIC_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
fi
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="<SERVER_IP>"
fi

echo -e "\n${C_GREEN}===============================================${C_RESET}"
echo -e "${C_GREEN}✓ Setup Complete!${C_RESET}"
echo -e "${C_GREEN}===============================================${C_RESET}"
echo -e "${C_BOLD}Portal:${C_RESET} ${C_BLUE}http://${PUBLIC_IP}:${HTTP_PORT}/portal/${C_RESET}"
echo -e "${C_BOLD}Admin:${C_RESET}  ${C_BLUE}http://${PUBLIC_IP}:${HTTP_PORT}/admin/${C_RESET}"
echo -e "${C_BOLD}API:${C_RESET}    ${C_BLUE}http://${PUBLIC_IP}:${HTTP_PORT}/healthz${C_RESET}"
echo
echo -e "${C_BOLD}Admin bootstrap token:${C_RESET}"
echo -e "  ${C_YELLOW}${ADMIN_TOKEN}${C_RESET}"
echo -e "${C_GREEN}===============================================${C_RESET}\n"

if confirm "Create first admin user now?" y; then
  ADMIN_EMAIL="$(prompt "Admin email" "")"
  if [ -n "$ADMIN_EMAIL" ]; then
    info "Bootstrapping admin user..."
    if curl -fsS -X POST \
      -H "content-type: application/json" \
      -H "x-admin-token: ${ADMIN_TOKEN}" \
      -d "{\"email\":\"${ADMIN_EMAIL}\"}" \
      "http://localhost:${HTTP_PORT}/v1/admin/bootstrap" > /dev/null; then
      success "Admin created successfully!"
    else
      error "Failed to create admin."
    fi
  fi
fi
