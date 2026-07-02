#!/bin/bash
set -e

PLIST_DIR="$HOME/Library/LaunchAgents"
FAST_PLIST="$PLIST_DIR/com.hedwig.slack-sync.plist"
BACKFILL_PLIST="$PLIST_DIR/com.hedwig.slack-sync-backfill.plist"
LOG_DIR="$HOME/projects/slack-sync/logs"

mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$FAST_PLIST" << 'EOF'
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
    <string>cd $HOME/projects/slack-sync &amp;&amp; PATH=/opt/homebrew/opt/node@22/bin:$PATH /opt/homebrew/opt/node@22/bin/npx tsx src/sync.ts >> $HOME/projects/slack-sync/logs/sync.log 2>&amp;1</string>
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/hedwig-agent/projects/slack-sync/logs/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hedwig-agent/projects/slack-sync/logs/launchd-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>/Users/hedwig-agent</string>
  </dict>
</dict>
</plist>
EOF

cat > "$BACKFILL_PLIST" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hedwig.slack-sync-backfill</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd $HOME/projects/slack-sync &amp;&amp; PATH=/opt/homebrew/opt/node@22/bin:$PATH SLACK_SYNC_FULL_BACKFILL=1 /opt/homebrew/opt/node@22/bin/npx tsx src/sync.ts >> $HOME/projects/slack-sync/logs/backfill.log 2>&amp;1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>15</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/Users/hedwig-agent/projects/slack-sync/logs/backfill-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hedwig-agent/projects/slack-sync/logs/backfill-launchd-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>/Users/hedwig-agent</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload "$FAST_PLIST" 2>/dev/null || true
launchctl unload "$BACKFILL_PLIST" 2>/dev/null || true
launchctl load "$FAST_PLIST"
launchctl load "$BACKFILL_PLIST"

echo "LaunchAgents installed:"
echo "- $FAST_PLIST (every 15 minutes incremental sync)"
echo "- $BACKFILL_PLIST (3:15 AM full backfill batch)"
echo "Logs: $LOG_DIR/sync.log and $LOG_DIR/backfill.log"
