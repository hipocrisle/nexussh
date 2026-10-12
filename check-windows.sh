#!/bin/bash
# Быстрая проверка сборки под Windows БЕЗ полной сборки окна.
#
# ⛔ Нужна потому, что часть кода существует только под Windows —
# повышение прав, именованные каналы, ConPTY, — и опечатка там всплывает
# лишь в облачной сборке, а это двадцать минут ожидания.
set -e
cd "$(dirname "$0")"
npm --prefix desktop run build >/dev/null
# ⛔ Для ПРОВЕРКИ сборки вложенные файлы не нужны, но без них сборщик
# отказывается начинать. Кладём пустышки — в выпуск они не попадают,
# там эти файлы скачиваются по-настоящему.
mkdir -p desktop/src-tauri/binaries
for stub in xray-x86_64-pc-windows-msvc.exe; do
  [ -f "desktop/src-tauri/binaries/$stub" ] || : > "desktop/src-tauri/binaries/$stub"
done
docker run --rm \
  -v "$PWD:/w" -w /w/desktop/src-tauri \
  -v "$PWD/.cargo-cache:/usr/local/cargo/registry" \
  rust:latest bash -c '
    set -e
    export PATH=/usr/local/cargo/bin:$PATH
    apt-get update -qq >/dev/null
    # ⛔ nasm и cmake нужны криптографической части: без них сборка под
    # Windows падает на ней, не дойдя до нашего кода.
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq clang lld llvm nasm cmake >/dev/null 2>&1
    rustup target add x86_64-pc-windows-msvc >/dev/null
    command -v cargo-xwin >/dev/null || cargo install --locked cargo-xwin >/dev/null
    cargo xwin check --target x86_64-pc-windows-msvc
  '
