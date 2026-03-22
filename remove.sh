#!/bin/bash
set -euo pipefail

# remove.sh — Remove claude-bridge from the remote host
#
# Required env vars:
#   DEPLOY_HOST — IP or hostname of the remote server
#
# Optional env vars:
#   DEPLOY_KEY  — Path to SSH private key (default: ~/.ssh/id_rsa)

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
SSH_OPTS="-i ${KEY} -o StrictHostKeyChecking=no"

echo "==> Removing ${APP_NAME} from ${HOST}..."
ssh ${SSH_OPTS} ubuntu@${HOST} << REMOTE
docker stop app-${APP_NAME} 2>/dev/null || true
docker rm app-${APP_NAME} 2>/dev/null || true
rm -f /etc/caddy/apps/${APP_NAME}.caddy
sudo systemctl reload caddy
echo "==> Removed. Data preserved at /opt/apps/${APP_NAME}/data/"
REMOTE

echo "==> Done."
