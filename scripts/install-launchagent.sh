#!/bin/bash
set -e

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/com.hedwig.slack-sync.plist"
LOG_DIR="$HOME/projects/slack-sync/logs"

mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST_FILE" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hedwig.slack-sync</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd $HOME/projects/slack-sync &amp;&amp; /usr/local/bin/npx tsx src/sync.ts >> $HOME/projects/slack-sync/logs/sync.log 2>&amp;1</string>
  </array>

  <key>StartInterval</key>
  <integer>3600</integer>

  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>/Users/hedwig-agent/projects/slack-sync/logs/launchd.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/hedwig-agent/projects/slack-sync/logs/launchd-error.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>/Users/hedwig-agent</string>
  </dict>
</dict>
</plist>
EOF

# Unload if already loaded
launchctl unload "$PLIST_FILE" 2>/dev/null || true

# Load the plist
launchctl load "$PLIST_FILE"

echo "LaunchAgent installed: $PLIST_FILE"
echo "Runs every 3600 seconds (1 hour)"
echo "Logs: $LOG_DIR/sync.log"
