# Kivana Server (kivana-api)

## Quick Deploy (fresh Ubuntu)

## Guided Setup (Recommended)

After a fresh server install, run:

```bash
curl -fsSL https://raw.githubusercontent.com/Litas-dev/Kivana-server/main/kivana-api/scripts/setup-wizard.sh | bash
```

This writes `.env`, starts Docker, waits for health, then prints the Portal/Admin URLs and can create the first admin user.

1) Install Docker + Compose:

```bash
apt-get update -y
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${VERSION_CODENAME}) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

2) Clone the repo:

```bash
mkdir -p /opt/kivana
cd /opt/kivana
git clone https://github.com/Litas-dev/Kivana-server.git
cd Kivana-server/kivana-api
```

3) Create `.env`:

```bash
cp .env.example .env
```

Edit `.env` and set:
- `JWT_SECRET` to a long random value
- `ADMIN_TOKEN` to a long random value
- `POSTGRES_PASSWORD` to a strong password
- `KIVANA_HTTP_PORT=80` if you want URLs without `:8080`

4) Start:

```bash
docker compose up -d --build
```

5) Check health:

```bash
curl -fsS http://localhost:8080/healthz && echo
```

## URLs

- If `KIVANA_HTTP_PORT=80`:
  - API: `http://SERVER_IP/`
  - Admin UI: `http://SERVER_IP/admin/`
  - Portal UI: `http://SERVER_IP/portal/`

- If `KIVANA_HTTP_PORT=8080`:
  - API: `http://SERVER_IP:8080/`
  - Admin UI: `http://SERVER_IP:8080/admin/`
  - Portal UI: `http://SERVER_IP:8080/portal/`

## Admin Bootstrap

If `ADMIN_TOKEN` is set, you can bootstrap an admin user:

```bash
curl -fsS -X POST \
  -H "content-type: application/json" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -d '{"email":"you@example.com"}' \
  http://SERVER_IP:8080/v1/admin/bootstrap
```

## Update (pull + rebuild)

```bash
cd /opt/kivana/Kivana-server/kivana-api
git pull
docker compose up -d --build
```
