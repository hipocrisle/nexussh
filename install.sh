#!/usr/bin/env bash
# NexuSSH Linux installer — downloads the latest AppImage into a user-writable
# location and registers a desktop launcher. Because the AppImage lives under
# ~/.local (owned by you, no root), the built-in auto-updater can rewrite it in
# place — "Install and restart" just works.
#
#   curl -fsSL https://raw.githubusercontent.com/hipocrisle/nexussh/main/install.sh | bash
#
set -euo pipefail

REPO="hipocrisle/nexussh"
BIN_DIR="$HOME/.local/bin"
APP_PATH="$BIN_DIR/NexuSSH.AppImage"
ICON_DIR="$HOME/.local/share/icons/hicolor/128x128/apps"
DESKTOP_DIR="$HOME/.local/share/applications"

say()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -m)" = "x86_64" ] || die "Поддерживается только x86_64 (у вас $(uname -m))."

# Warn if an old .deb install is still around — it would shadow this one.
if command -v dpkg >/dev/null 2>&1 && dpkg -l nexussh 2>/dev/null | grep -q '^ii'; then
  warn "Найдена старая deb-установка. Удалите её, чтобы не путалась:  sudo apt remove nexussh"
fi

say "Ищу последний релиз NexuSSH…"
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | grep -o "https://[^\"]*_amd64\.AppImage" | head -1)
[ -n "$URL" ] || die "Не нашёл AppImage в последнем релизе."

mkdir -p "$BIN_DIR" "$ICON_DIR" "$DESKTOP_DIR"

say "Скачиваю $(basename "$URL")…"
curl -fL --progress-bar -o "$APP_PATH" "$URL"
chmod +x "$APP_PATH"

# Best-effort icon (won't fail the install if it 404s on an old tag).
curl -fsSL -o "$ICON_DIR/nexussh.png" \
  "https://raw.githubusercontent.com/$REPO/main/desktop/src-tauri/icons/128x128.png" 2>/dev/null || true

cat > "$DESKTOP_DIR/nexussh.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=NexuSSH
Comment=SSH/SFTP client
Exec=$APP_PATH
Icon=nexussh
Terminal=false
Categories=Network;Utility;
EOF
update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

# AppImages need FUSE; on minimal/newer Ubuntu it may be missing.
if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  warn "Для запуска AppImage нужен FUSE. Если не стартует:  sudo apt install libfuse2"
fi

say "Готово. NexuSSH установлен: $APP_PATH"
say "Запуск: найдите «NexuSSH» в меню приложений, или выполните:  $APP_PATH"
if ! printf '%s' "$PATH" | grep -q "$BIN_DIR"; then
  warn "$BIN_DIR не в \$PATH — для запуска из терминала по имени добавьте его, либо зовите по полному пути."
fi
