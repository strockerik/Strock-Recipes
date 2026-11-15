#!/bin/bash
# A weekly backup on this Mac: every Sunday at 09:00 (or at the next wake, if the
# Mac was asleep then), launchd runs scripts/backup_recipes.py with the python3 you
# use in Terminal. Output goes to ~/Library/Logs/house-index-backup.log.
#
#   bash scripts/launchd/install_backup_job.sh            install, or update after moving the repo
#   bash scripts/launchd/install_backup_job.sh --remove   uninstall
#
# The job reads the secret key the same way the script does (notes.md). If the log
# says "Operation not permitted", macOS is keeping launchd out of ~/Desktop: allow
# that python3 in System Settings → Privacy & Security → Full Disk Access (or move
# the repo out of Desktop and run this again).
LABEL="com.houseindex.backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$HOME/Library/Logs/house-index-backup.log"
DOMAIN="gui/$(id -u)"

if [ "$1" = "--remove" ]; then
  launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  echo "Removed the weekly backup job."
  exit 0
fi
if [ -n "$1" ]; then echo "Usage: bash scripts/launchd/install_backup_job.sh [--remove]"; exit 1; fi

PY="$(command -v python3)"
if [ -z "$PY" ]; then echo "No python3 on your PATH."; exit 1; fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$REPO/scripts/backup_recipes.py</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF
launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null
if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then echo "launchctl couldn't load $PLIST"; exit 1; fi
echo "Installed: a weekly backup, Sundays 09:00, with $PY."
echo "Run it once now to check:"
echo "  launchctl kickstart $DOMAIN/$LABEL"
echo "  tail -5 $LOG"
