<div align="center">

# 🛰️ NexuSSH

**Кроссплатформенный SSH-клиент на Tauri 2.**

[![Release](https://img.shields.io/github/v/release/hipocrisle/nexussh?include_prereleases&label=release&color=2ea043)](https://github.com/hipocrisle/nexussh/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20Android-444)](#-установка)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)](https://tauri.app)
[![SSH](https://img.shields.io/badge/SSH-pure%20Rust%20(russh)-dea584)](https://github.com/Eugeny/russh)

[English](README.md) · **Русский**

</div>

---

Нативный SSH-клиент (~15 МБ, Tauri 2 + Rust) с тёмным UI, шифрованным хранилищем
учёток, end-to-end шифрованной синхронизацией между устройствами и опциональным
встроенным VPN-транспортом.

## Возможности

**Терминал**
- Поддержка сплит вкладок и горячих клавиш
- Статус-строка с состоянием соединения
- Поддержка тем и шрифтов
- Встроенный поиск и история сессий

**Подключение**
- Быстрое подключение по ip адресу
- Проверка ключа хоста (TOFU, `known_hosts.json`); SFTP тоже проверяет ключи
- Поддержка legacy-алгоритмов для старого железа Cisco IOS / ESXi
- SFTP: просмотр и передача файлов по тому же соединению

**Безопасность**
- Шифрованное хранилище учёток (age) с авто-блокировкой по простою
- Envelope-шифрование сохранённых хостов, шифруемый список хостов, ограниченный доступ к ФС, строгий CSP

**Синхронизация**
- Облачная синхронизация хостов и настроек, end-to-end шифрование
- Ключ восстановления и самовосстанавливающийся force-resync
- Массовый импорт, экспорт/импорт хостов между ПК

**Встроенный VPN-транспорт**
- «Через встроенный VPN» для каждого хоста — доступ из сетей, где хост заблокирован, без отдельного VPN-клиента и прав администратора
- Внутри [xray-core](https://github.com/XTLS/Xray-core); вставь свою подписку (ссылка VLESS / Reality / VMess / Trojan / Shadowsocks)
- Userspace локальный SOCKS (без системного TUN); подписки хранятся локально и не синхронизируются

**Платформы**
- Windows, Linux (`.deb` + `.rpm`), Android (подписанный APK)
- Self-hosted автообновление (в приложении *Установить и перезапустить*)
- Русский и английский интерфейс

## 📥 Установка

Со **[страницы релизов](https://github.com/hipocrisle/nexussh/releases/latest)**:

| ОС | Файл | Как |
|----|------|-----|
| Windows | `NexuSSH_*_x64-setup.exe` | двойной клик |
| Linux (Debian/Ubuntu) | `NexuSSH_*_amd64.deb` | `sudo apt install ./NexuSSH_*_amd64.deb` |
| Linux (Fedora) | `NexuSSH_*.x86_64.rpm` | `sudo dnf install ./NexuSSH_*.x86_64.rpm` |
| Linux (RHEL/Rocky/Alma/Oracle/CentOS **10**) | `NexuSSH_*.x86_64.rpm` | **сначала EPEL** → `sudo dnf install -y epel-release`, затем `sudo dnf install ./NexuSSH_*.x86_64.rpm` |
| Android | `NexuSSH_*.apk` | установить подписанный APK |

> ⚠️ **RHEL-семейство — поддерживается только версия 10.** RHEL/Rocky/Alma/Oracle/CentOS
> **10** имеют `webkit2gtk4.1` в EPEL; версии **8 и 9 его НЕ имеют вообще** (ни base,
> ни EPEL, ни CRB) — там только старый webkit 4.0, который Tauri 2 не умеет. Поэтому
> rpm ставится **только на EL10**:
> ```
> sudo dnf install -y epel-release
> sudo dnf install ./NexuSSH_*.x86_64.rpm
> ```
> После подключения EPEL rpm ставится и двойным кликом. (В Fedora `webkit2gtk4.1`
> в базовых репозиториях — EPEL не нужен.)

Linux-сборки используют системный WebKit (`.deb`/`.rpm`), не AppImage. Встроенное
**Установить и перезапустить** держит версию актуальной.

## 🛠️ Сборка из исходников

```bash
git clone https://github.com/hipocrisle/nexussh.git
cd nexussh/desktop
npm install
npm run tauri dev      # dev
npm run tauri build    # инсталляторы
```

Нужны Rust (stable), Node 18+ и
[пререквизиты Tauri 2](https://tauri.app/start/prerequisites/) для вашей ОС.

## 🧱 Стек

- [Tauri 2](https://tauri.app) — Rust-бэкенд + системный WebView
- React 19 + Vite + Tailwind
- [xterm.js](https://xtermjs.org) — рендер терминала
- [russh](https://github.com/Eugeny/russh) — SSH на чистом Rust
- age — шифрование хранилища
- [xray-core](https://github.com/XTLS/Xray-core) — встроенный VPN-транспорт

## 📄 Лицензия

См. [LICENSE](LICENSE).
