#!/usr/bin/env bash
# NexuSSH Linux installer — one command, no dependencies, auto-updates.
#
#   curl -fsSL https://raw.githubusercontent.com/hipocrisle/nexussh/main/install.sh | bash
#
# Drops the latest AppImage into the user's ~/.local (writable → the in-app
# "Install and restart" updater rewrites it in place) and registers a menu
# launcher that runs it with APPIMAGE_EXTRACT_AND_RUN=1, so FUSE is NOT required.
set -euo pipefail

REPO="hipocrisle/nexussh"

say()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -m)" = "x86_64" ] || die "Поддерживается только x86_64 (у вас $(uname -m))."

# Install for the real desktop user even if invoked via sudo / from a root shell,
# otherwise the launcher lands in /root and never shows up in the user's menu.
TARGET_USER="$(id -un)"
TARGET_HOME="$HOME"
RUN_AS=""
if [ "$(id -u)" -eq 0 ]; then
  U="${SUDO_USER:-}"
  if [ -z "$U" ] || [ "$U" = "root" ]; then
    U="$(loginctl list-sessions --no-legend 2>/dev/null | awk '$3!="root"{print $3; exit}' || true)"
  fi
  if [ -z "$U" ]; then
    U="$(getent passwd | awk -F: '$3>=1000 && $3<65000 {print $1; exit}' || true)"
  fi
  if [ -n "$U" ] && [ "$U" != "root" ]; then
    TARGET_USER="$U"
    TARGET_HOME="$(getent passwd "$U" | cut -d: -f6)"
    RUN_AS="sudo -u $U"
    say "Запущено от root — ставлю для пользователя «$U»."
  else
    warn "Не смог определить обычного пользователя — ставлю для root."
  fi
fi

BIN_DIR="$TARGET_HOME/.local/bin"
APP_PATH="$BIN_DIR/NexuSSH.AppImage"
ICON_DIR="$TARGET_HOME/.local/share/icons/hicolor/128x128/apps"
DESKTOP_DIR="$TARGET_HOME/.local/share/applications"

mkdir -p "$BIN_DIR" "$ICON_DIR" "$DESKTOP_DIR"

say "Ищу последний релиз NexuSSH…"
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | grep -o "https://[^\"]*_amd64\.AppImage" | head -1)
[ -n "$URL" ] || die "Не нашёл AppImage в последнем релизе."

say "Скачиваю $(basename "$URL")…"
curl -fL --progress-bar -o "$APP_PATH" "$URL"
chmod +x "$APP_PATH"

curl -fsSL -o "$ICON_DIR/nexussh.png" \
  "https://raw.githubusercontent.com/$REPO/main/desktop/src-tauri/icons/128x128.png" 2>/dev/null || true

# APPIMAGE_EXTRACT_AND_RUN=1 → runs without FUSE; APPIMAGE env is still set so the
# updater knows which file to rewrite.
cat > "$DESKTOP_DIR/nexussh.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=NexuSSH
Comment=SSH/SFTP client
Exec=env APPIMAGE_EXTRACT_AND_RUN=1 "$APP_PATH"
Icon=nexussh
Terminal=false
Categories=Network;Utility;
EOF
chmod +x "$DESKTOP_DIR/nexussh.desktop"

# Make everything owned by the target user when we ran as root.
if [ -n "$RUN_AS" ]; then
  chown -R "$TARGET_USER": "$TARGET_HOME/.local/bin" "$TARGET_HOME/.local/share/applications" \
    "$TARGET_HOME/.local/share/icons" 2>/dev/null || true
fi

$RUN_AS update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
$RUN_AS gtk-update-icon-cache -f -t "$TARGET_HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

say "Готово — «NexuSSH» появится в меню приложений (иногда нужно перелогиниться в графику)."
say "Запустить прямо сейчас:"
printf '    APPIMAGE_EXTRACT_AND_RUN=1 %s\n' "$APP_PATH"
