#!/usr/bin/env bash
set -euo pipefail

echo "This script prints recommended macOS commands to increase file limits for the watcher (does not run them)."
echo
echo "Current limits:"
launchctl limit maxfiles || true
sysctl kern.maxfiles kern.maxfilesperproc || true
echo
cat <<'EOF'
Temporary (until reboot) increase (run with sudo):
  sudo sysctl -w kern.maxfiles=524288
  sudo sysctl -w kern.maxfilesperproc=524288

Persistent (recommended): create /Library/LaunchDaemons/limit.maxfiles.plist with the following content, then load it with launchctl:
EOF

cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>limit.maxfiles</string>
    <key>ProgramArguments</key>
    <array>
      <string>launchctl</string>
      <string>limit</string>
      <string>maxfiles</string>
      <string>524288</string>
      <string>524288</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
  </dict>
</plist>
PLIST

cat <<'EOF'
To install persistently (requires sudo):
  sudo tee /Library/LaunchDaemons/limit.maxfiles.plist >/dev/null <<'PLIST'
  [paste the plist content here]
PLIST
  sudo launchctl load -w /Library/LaunchDaemons/limit.maxfiles.plist

If you prefer not to change system settings, keep using CHOKIDAR_USEPOLLING=true in your dev command (already enabled).
EOF
