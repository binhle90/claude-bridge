#!/bin/bash
set -euo pipefail

# setup-sync-daemon.sh — Generate and install the macOS launchd plist for the sync daemon.
#
# This script:
#   1. Detects your node path (via `which node`)
#   2. Resolves the absolute path to push-to-remote.js
#   3. Generates a launchd plist
#   4. Installs it to ~/Library/LaunchAgents/
#   5. Loads the daemon
#
# Prerequisites:
#   - Node.js installed
#   - ~/.claude-mem/remote-sync-env configured with CLAUDE_MEM_REMOTE_URL and CLAUDE_MEM_REMOTE_API_KEY
#   - CLAUDE_MEM_SYNC_PROJECT_ROOT exported (or set in remote-sync-env)

LABEL="com.claude-mem-sync"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

# Detect node path
NODE_PATH=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found in PATH. Install Node.js first."
  exit 1
fi
echo "Using node: ${NODE_PATH}"

# Resolve script path (relative to this script's directory)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNC_SCRIPT="${SCRIPT_DIR}/push-to-remote.js"

if [ ! -f "$SYNC_SCRIPT" ]; then
  echo "Error: push-to-remote.js not found at ${SYNC_SCRIPT}"
  exit 1
fi
echo "Sync script: ${SYNC_SCRIPT}"

# Ensure log directory exists
LOG_DIR="${HOME}/.claude-mem/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/sync.log"
echo "Log file: ${LOG_FILE}"

# Unload existing daemon if present
if launchctl list | grep -q "${LABEL}" 2>/dev/null; then
  echo "Unloading existing daemon..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Generate plist
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${SYNC_SCRIPT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
</dict>
</plist>
EOF

echo "Generated plist at ${PLIST_PATH}"

# Load the daemon
launchctl load "$PLIST_PATH"
echo "Daemon loaded. Check status with: launchctl list | grep ${LABEL}"
echo "View logs with: tail -f ${LOG_FILE}"
