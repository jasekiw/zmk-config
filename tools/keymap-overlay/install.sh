#!/usr/bin/env bash
# Register the cheat sheet with GNOME so it shows up in the app grid, and
# optionally start it with every session. Nothing is copied — the .desktop
# entries point straight at the script in this repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/zmk-cheatsheet"
APPS="$HOME/.local/share/applications"
AUTOSTART="$HOME/.config/autostart"

write_entry() {
    cat > "$1" <<DESKTOP
[Desktop Entry]
Type=Application
Name=ZMK Cheat Sheet
Comment=Always-on-top overlay of the Piantor Pro BT keymap
Exec=$EXEC
Icon=input-keyboard
Terminal=false
Categories=Utility;
StartupNotify=false
DESKTOP
}

mkdir -p "$APPS"
write_entry "$APPS/zmk-cheatsheet.desktop"
echo "installed $APPS/zmk-cheatsheet.desktop"

if [[ "${1:-}" == "--autostart" ]]; then
    mkdir -p "$AUTOSTART"
    write_entry "$AUTOSTART/zmk-cheatsheet.desktop"
    echo "installed $AUTOSTART/zmk-cheatsheet.desktop"
else
    echo "re-run with --autostart to also launch it at login"
fi
