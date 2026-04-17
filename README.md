<div align="center">

# NexTerm

### The SSH client you actually want to use.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-supported-black?logo=apple&logoColor=white)](https://github.com/cognidevai/nexterm/releases)
[![Linux](https://img.shields.io/badge/Linux-soon-FCC624?logo=linux&logoColor=black)](#)
[![Windows](https://img.shields.io/badge/Windows-soon-0078D6?logo=windows&logoColor=white)](#)
[![Tauri 2.0](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![Rust](https://img.shields.io/badge/Rust-backend-DEA584?logo=rust&logoColor=black)](https://www.rust-lang.org)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)

</div>

---

Most SSH clients feel like they were designed in 2005. You either get a powerful tool with a terrible UI, or a pretty app that can barely handle real workflows.

**NexTerm** is different. It's a desktop SSH client built from scratch with Tauri 2.0 and Rust — terminal, SFTP, tunnels, and an encrypted vault, all in one lightweight app. No Electron bloat. No Java runtime. Just a fast, native binary that respects your machine and your time.

---

## Why NexTerm?

**One server, multiple users.** Most clients force you to duplicate profiles for every user on the same server. NexTerm lets you save one server and add as many users as you need — root, deploy, admin — each with their own credentials. Test each connection right from the profile editor.

**Your credentials are actually safe.** Passwords and keys are encrypted with AES-256-GCM, derived through Argon2id. Nothing is ever stored in plain text. The vault locks automatically when you step away.

**SFTP that doesn't feel like an afterthought.** Dual-pane browser with drag-and-drop, type-to-search, inline actions per pane, and a file viewer. Upload, download, and manage files without leaving the app.

**SSH tunnels without the terminal gymnastics.** Create local and remote port forwards visually. Monitor traffic in real time. No more remembering `-L 3306:localhost:3306`.

---

## Screenshots

<div align="center">

|  |  |
|:---:|:---:|
| ![Terminal](screenshots/terminal.png) | ![Profile Editor](screenshots/profile-editor.png) |
| **Terminal Emulator** | **Multi-User Profile Editor** |
| ![SFTP](screenshots/sftp.png) | ![Tunnels](screenshots/tunnels.png) |
| **SFTP File Browser** | **SSH Tunnels** |

</div>

---

## Features

### Terminal
- GPU-accelerated rendering via **xterm.js 6**
- Multi-tab — open as many terminals as you need per session
- Search, themes, fonts, Unicode, emoji

### SFTP
- Dual-pane: local on the left, remote on the right
- Drag-and-drop uploads and downloads
- Type-to-search to quickly find files
- Per-pane actions: upload, download, refresh, new folder
- Built-in file viewer

### SSH Tunnels
- Local forwarding (`-L`) and remote forwarding (`-R`)
- Live traffic stats (bytes sent/received)
- Create, pause, and manage multiple tunnels per session

### Multi-User Profiles
- One profile = one server, N users
- Each user has independent auth (password or key)
- Test each user's connection directly in the profile editor
- Auto-save credentials on successful test

### Encrypted Vault
- **AES-256-GCM** encryption for all stored credentials
- Master password derived with **Argon2id** (GPU + side-channel resistant)
- Auto-lock after inactivity
- Credentials never touch disk in plain text

### Host Key Verification
- Trust-on-first-use (TOFU) — like SSH `known_hosts`
- Alerts on host key changes (MITM protection)

### Onboarding Tour
- Step-by-step guided tour on first launch
- Spotlight tooltips explaining each part of the interface
- Replay anytime via the **?** button in the status bar

### i18n
- English and Spanish
- Extensible for more languages

---

## Install

Download the latest release:

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | [NexTerm_aarch64.dmg](https://github.com/cognidevai/nexterm/releases/latest) |
| macOS (Intel) | Coming soon |
| Linux | Coming soon |
| Windows | Coming soon |

> Binaries are unsigned. On macOS, run `xattr -cr /Applications/NexTerm.app` after installing.

---

## Build from Source

```bash
# Prerequisites: Rust (stable), Node.js 18+, pnpm 9+
# + Tauri prerequisites for your platform: https://v2.tauri.app/start/prerequisites/

git clone https://github.com/cognidevai/nexterm.git
cd nexterm
pnpm install
pnpm tauri dev      # development (hot-reload)
pnpm tauri build    # production binary
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Tauri 2.0 |
| Backend | Rust |
| SSH | russh (async SSH2) |
| Frontend | React 19 + TypeScript 5.7 (strict) |
| Bundler | Vite 6 |
| State | Zustand 5 |
| Terminal | xterm.js 6 |
| Encryption | AES-256-GCM + Argon2id |
| CI/CD | GitHub Actions |

---

## Security

1. **Master Password** — Set on first launch. Never stored anywhere.
2. **Key Derivation** — Argon2id with unique random salt produces a 256-bit key.
3. **Encryption** — AES-256-GCM encrypts all credentials with integrity verification.
4. **At Rest** — Vault file contains only ciphertext + salt. Unrecoverable without the master password.
5. **In Memory** — Decrypted credentials are cleared on lock or exit.

> Passwords and private keys are never written to disk in plain text.

Found a vulnerability? Report it privately via [GitHub Security Advisories](https://github.com/cognidevai/nexterm/security/advisories).

---

## Contributing

1. Open an issue first
2. Fork and create a feature branch
3. Make your changes with clear commits
4. Submit a PR referencing the issue

---

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

Built by [CogniDevAI](https://github.com/cognidevai)

</div>

---
---

<div align="center">

## Español

</div>

<div align="center">

# NexTerm

### El cliente SSH que de verdad querés usar.

</div>

---

La mayoría de clientes SSH parecen diseñados en 2005. O tenés una herramienta poderosa con una interfaz terrible, o una app bonita que apenas sirve para flujos de trabajo reales.

**NexTerm** es diferente. Es un cliente SSH de escritorio construido desde cero con Tauri 2.0 y Rust — terminal, SFTP, túneles y una bóveda cifrada, todo en una sola app liviana. Sin el peso de Electron. Sin Java. Solo un binario nativo, rápido, que respeta tu máquina y tu tiempo.

---

## Por qué NexTerm?

**Un servidor, múltiples usuarios.** La mayoría de clientes te obligan a duplicar perfiles para cada usuario del mismo servidor. NexTerm te deja guardar un servidor y agregar todos los usuarios que necesites — root, deploy, admin — cada uno con sus propias credenciales. Probá cada conexión directo desde el editor de perfiles.

**Tus credenciales están realmente seguras.** Contraseñas y claves se cifran con AES-256-GCM, derivadas con Argon2id. Nada se guarda en texto plano. La bóveda se bloquea automáticamente cuando te alejás.

**SFTP que no parece un agregado de último momento.** Explorador de doble panel con drag-and-drop, búsqueda al escribir, acciones por panel, y visor de archivos. Subí, descargá y gestioná archivos sin salir de la app.

**Túneles SSH sin gimnasia en la terminal.** Creá port forwards locales y remotos de forma visual. Monitoreá el tráfico en tiempo real. No más memorizar `-L 3306:localhost:3306`.

---

## Capturas de Pantalla

<div align="center">

|  |  |
|:---:|:---:|
| ![Terminal](screenshots/terminal.png) | ![Editor de Perfiles](screenshots/profile-editor.png) |
| **Emulador de Terminal** | **Editor de Perfiles Multi-Usuario** |
| ![SFTP](screenshots/sftp.png) | ![Túneles](screenshots/tunnels.png) |
| **Explorador de Archivos SFTP** | **Túneles SSH** |

</div>

---

## Características

### Terminal
- Renderizado acelerado por GPU con **xterm.js 6**
- Multi-pestaña — abrí todas las terminales que necesites por sesión
- Búsqueda, temas, fuentes, Unicode, emojis

### SFTP
- Doble panel: local a la izquierda, remoto a la derecha
- Drag-and-drop para subir y descargar
- Búsqueda rápida al escribir
- Acciones por panel: subir, descargar, actualizar, nueva carpeta
- Visor de archivos integrado

### Túneles SSH
- Reenvío local (`-L`) y remoto (`-R`)
- Estadísticas de tráfico en vivo (bytes enviados/recibidos)
- Creá, pausá y administrá múltiples túneles por sesión

### Perfiles Multi-Usuario
- Un perfil = un servidor, N usuarios
- Cada usuario con autenticación independiente (password o key)
- Probá la conexión de cada usuario directo desde el editor
- Guardado automático de credenciales al probar exitosamente

### Bóveda Cifrada
- Cifrado **AES-256-GCM** para todas las credenciales
- Contraseña maestra derivada con **Argon2id** (resistente a GPU y side-channel)
- Bloqueo automático por inactividad
- Las credenciales nunca tocan el disco en texto plano

### Verificación de Host
- Trust-on-first-use (TOFU) — como `known_hosts` de SSH
- Alertas ante cambios de clave del host (protección MITM)

### Tour de Onboarding
- Recorrido guiado paso a paso en el primer inicio
- Tooltips con spotlight explicando cada parte de la interfaz
- Repetilo cuando quieras con el botón **?** en la barra de estado

### i18n
- Inglés y español
- Extensible para más idiomas

---

## Instalación

| Plataforma | Descarga |
|------------|----------|
| macOS (Apple Silicon) | [NexTerm_aarch64.dmg](https://github.com/cognidevai/nexterm/releases/latest) |
| macOS (Intel) | Próximamente |
| Linux | Próximamente |
| Windows | Próximamente |

> Los binarios no están firmados. En macOS, ejecutá `xattr -cr /Applications/NexTerm.app` después de instalar.

---

## Compilar desde el Código Fuente

```bash
# Requisitos: Rust (stable), Node.js 18+, pnpm 9+
# + Prerequisitos de Tauri: https://v2.tauri.app/start/prerequisites/

git clone https://github.com/cognidevai/nexterm.git
cd nexterm
pnpm install
pnpm tauri dev      # desarrollo (hot-reload)
pnpm tauri build    # binario de producción
```

---

## Stack Tecnológico

| Capa | Tecnología |
|------|-----------|
| Runtime | Tauri 2.0 |
| Backend | Rust |
| SSH | russh (SSH2 asíncrono) |
| Frontend | React 19 + TypeScript 5.7 (estricto) |
| Bundler | Vite 6 |
| Estado | Zustand 5 |
| Terminal | xterm.js 6 |
| Cifrado | AES-256-GCM + Argon2id |
| CI/CD | GitHub Actions |

---

## Seguridad

1. **Contraseña Maestra** — Se establece en el primer inicio. Nunca se almacena.
2. **Derivación de Clave** — Argon2id con salt aleatorio único produce una clave de 256 bits.
3. **Cifrado** — AES-256-GCM cifra todas las credenciales con verificación de integridad.
4. **En Reposo** — El archivo de la bóveda contiene solo texto cifrado + salt. Irrecuperable sin la contraseña maestra.
5. **En Memoria** — Las credenciales descifradas se eliminan al bloquear o cerrar.

> Las contraseñas y claves privadas nunca se escriben en disco en texto plano.

Encontraste una vulnerabilidad? Reportala de forma privada en [GitHub Security Advisories](https://github.com/cognidevai/nexterm/security/advisories).

---

## Contribuir

1. Abrí un issue primero
2. Hacé fork y creá una rama de feature
3. Hacé tus cambios con commits claros
4. Enviá un PR referenciando el issue

---

## Licencia

MIT — ver [LICENSE](LICENSE).

---

<div align="center">

Hecho por [CogniDevAI](https://github.com/cognidevai)

</div>
