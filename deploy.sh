#!/bin/bash
set -euo pipefail

# deploy.sh — Deploy claude-bridge to the remote host
#
# Required env vars:
#   DEPLOY_HOST   — IP or hostname of the remote server
#   DEPLOY_DOMAIN — Your base domain (e.g., example.com)
#
# Optional env vars:
#   DEPLOY_KEY    — Path to SSH private key (default: ~/.ssh/id_rsa)

HOST="${DEPLOY_HOST:-}"
KEY="${DEPLOY_KEY:-~/.ssh/id_rsa}"
CONFIG_FILE="deploy.config.json"

while [[ $# -gt 0 ]]; do
  case $1 in
    --host) HOST="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [ -z "$HOST" ]; then echo "Error: No host. Use --host IP or set DEPLOY_HOST."; exit 1; fi
if [ ! -f "$CONFIG_FILE" ]; then echo "Error: ${CONFIG_FILE} not found."; exit 1; fi

APP_NAME=$(jq -r '.name' "$CONFIG_FILE")
PORT=$(jq -r '.port' "$CONFIG_FILE")
MEMORY=$(jq -r '.resources.memory // "256m"' "$CONFIG_FILE")
CPUS=$(jq -r '.resources.cpus // "0.25"' "$CONFIG_FILE")
HEALTH_PATH=$(jq -r '.healthCheck' "$CONFIG_FILE")
CADDY_DOMAIN="${APP_NAME}.${DEPLOY_DOMAIN:-example.com}"

SSH_OPTS="-i ${KEY} -o StrictHostKeyChecking=no"

echo "==> Deploying ${APP_NAME} to ${HOST} (${CADDY_DOMAIN})..."

# Generate env file
ENV_FILE="/tmp/${APP_NAME}.env"
jq -r '.env | to_entries[] | "\(.key)=\(.value)"' "$CONFIG_FILE" > "$ENV_FILE"
# Generate unique random values for each __GENERATE__ placeholder
for _var in $(grep -o '^[A-Z_]*=__GENERATE__' "$ENV_FILE" | cut -d= -f1); do
  _val=$(openssl rand -hex 32)
  sed -i.bak "s/^${_var}=__GENERATE__$/${_var}=${_val}/" "$ENV_FILE"
  rm -f "${ENV_FILE}.bak"
done

# Substitute OAUTH_PASSWORD from env
if [ -n "${DEPLOY_OAUTH_PASSWORD:-}" ]; then
  sed -i.bak "s/__SET_OAUTH_PASSWORD__/${DEPLOY_OAUTH_PASSWORD}/" "$ENV_FILE"
  rm -f "${ENV_FILE}.bak"
fi

# Check if already deployed — preserve existing API key
EXISTING_KEY=$(ssh ${SSH_OPTS} ubuntu@${HOST} "cat /opt/apps/${APP_NAME}/.env 2>/dev/null | grep '^API_KEY=' | cut -d= -f2" || true)
if [ -n "$EXISTING_KEY" ]; then
  echo "==> Preserving existing API key"
  sed -i.bak "s/^API_KEY=.*/API_KEY=${EXISTING_KEY}/" "$ENV_FILE"
  rm -f "${ENV_FILE}.bak"
fi

# Preserve existing OAuth credentials on redeploy
EXISTING_OAUTH_CID=$(ssh ${SSH_OPTS} ubuntu@${HOST} "cat /opt/apps/${APP_NAME}/.env 2>/dev/null | grep '^OAUTH_CLIENT_ID=' | cut -d= -f2" || true)
if [ -n "$EXISTING_OAUTH_CID" ]; then
  echo "==> Preserving existing OAuth credentials"
  sed -i.bak "s/^OAUTH_CLIENT_ID=.*/OAUTH_CLIENT_ID=${EXISTING_OAUTH_CID}/" "$ENV_FILE"
  rm -f "${ENV_FILE}.bak"
fi
EXISTING_OAUTH_CS=$(ssh ${SSH_OPTS} ubuntu@${HOST} "cat /opt/apps/${APP_NAME}/.env 2>/dev/null | grep '^OAUTH_CLIENT_SECRET=' | cut -d= -f2" || true)
if [ -n "$EXISTING_OAUTH_CS" ]; then
  sed -i.bak "s/^OAUTH_CLIENT_SECRET=.*/OAUTH_CLIENT_SECRET=${EXISTING_OAUTH_CS}/" "$ENV_FILE"
  rm -f "${ENV_FILE}.bak"
fi

# Create archive
echo "==> Creating archive..."
ARCHIVE="/tmp/${APP_NAME}.tar.gz"
tar -czf "$ARCHIVE" --exclude='node_modules' --exclude='.git' --exclude='test' --exclude='sync' --exclude='docs' --exclude='*.md' .

# Upload
echo "==> Uploading..."
ssh ${SSH_OPTS} ubuntu@${HOST} "mkdir -p /opt/apps/${APP_NAME}"
scp ${SSH_OPTS} "$ARCHIVE" ubuntu@${HOST}:/opt/apps/${APP_NAME}/app.tar.gz
scp ${SSH_OPTS} "$ENV_FILE" ubuntu@${HOST}:/opt/apps/${APP_NAME}/.env

# Deploy on host
echo "==> Building and starting..."
ssh ${SSH_OPTS} ubuntu@${HOST} << REMOTE
set -euo pipefail
cd /opt/apps/${APP_NAME}
tar -xzf app.tar.gz
rm app.tar.gz

# Build Docker image
docker build -t app-${APP_NAME} .

# Stop old container
docker stop app-${APP_NAME} 2>/dev/null || true
docker rm app-${APP_NAME} 2>/dev/null || true

# Start new container
docker run -d \
  --name app-${APP_NAME} \
  --restart unless-stopped \
  --memory ${MEMORY} \
  --cpus ${CPUS} \
  --env-file .env \
  -p ${PORT}:${PORT} \
  -v /opt/apps/${APP_NAME}/data:/app/data \
  app-${APP_NAME}

# Write Caddy config (no TLS block — global config handles TLS)
sudo tee /etc/caddy/apps/${APP_NAME}.caddy > /dev/null << CADDY
${CADDY_DOMAIN} {
  reverse_proxy localhost:${PORT}
}
CADDY

# Reload Caddy
sudo systemctl reload caddy

# Health check
echo "==> Health check..."
for i in \$(seq 1 15); do
  if curl -sf http://localhost:${PORT}${HEALTH_PATH} > /dev/null 2>&1; then
    echo "==> Health check passed!"
    exit 0
  fi
  sleep 2
done
echo "==> Health check failed after 30s"
docker logs app-${APP_NAME} --tail 20
exit 1
REMOTE

# Print the API key for local config
API_KEY=$(ssh ${SSH_OPTS} ubuntu@${HOST} "cat /opt/apps/${APP_NAME}/.env | grep '^API_KEY=' | cut -d= -f2")
echo ""
echo "==> Deployed successfully to https://${CADDY_DOMAIN}"
echo "==> API Key: ${API_KEY}"
echo "==> Save this key to ~/.claude-mem/remote-sync-env and Claude Desktop config"

# Print OAuth credentials for Claude.ai connector setup
OAUTH_CID=$(ssh ${SSH_OPTS} ubuntu@${HOST} "cat /opt/apps/${APP_NAME}/.env | grep '^OAUTH_CLIENT_ID=' | cut -d= -f2")
OAUTH_CS=$(ssh ${SSH_OPTS} ubuntu@${HOST} "cat /opt/apps/${APP_NAME}/.env | grep '^OAUTH_CLIENT_SECRET=' | cut -d= -f2")
echo ""
echo "==> OAuth Client ID: ${OAUTH_CID}"
echo "==> OAuth Client Secret: ${OAUTH_CS}"
echo "==> Enter these in Claude.ai connector settings (Server URL: https://${CADDY_DOMAIN}/mcp)"

# Clean up
rm -f "$ARCHIVE" "$ENV_FILE"
