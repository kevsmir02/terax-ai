<!-- fork-copy: upstream translation; the authoritative description of this build is ../../README.md -->

> [!IMPORTANT]
> Terjemahan ini berasal dari Terax upstream. Fork ini menghapus permukaan AI bawaan yang dijelaskannya (chat, pelengkapan otomatis, tinjauan perubahan oleh AI, serta pengaturan penyedia dan kunci API). [`README.md`](../../README.md) menjelaskan build yang diterbitkan repositori ini.

<div align="center">
  <img src="../../public/logo.png" width="144" height="144" alt="Terax" />
  <h1>Terax</h1>
  <p><strong>Ruang kerja pengembangan ringan, berfokus pada terminal, dan berteknologi AI.</strong></p>
  <p><a href="https://terax.app">Situs web</a> · <a href="https://terax.app/docs">Dokumentasi</a> · <a href="https://github.com/crynta/Terax-website">Kode sumber situs web</a></p>

  <p>
    <img src="https://img.shields.io/github/v/release/crynta/terax-ai?label=version&color=blue" alt="versi" />
    <img src="https://img.shields.io/github/downloads/crynta/terax-ai/total?label=downloads&color=blue" alt="unduhan" />
    <img src="https://img.shields.io/badge/platform-Linux%20x86_64-lightgrey" alt="platform" />
    <a href="https://discord.gg/tyveTUyEp7"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://www.youtube.com/@crynta"><img src="https://img.shields.io/badge/Youtube-FF0000?logo=youtube&logoColor=white" alt="YouTube" /></a>
  </p>
</div>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.pl.md">Polski</a> | <a href="README.ru.md">Русский</a> | <a href="README.hi.md">हिन्दी</a>
</p>

---

Terax adalah lingkungan pengembangan (ADE) ringan, sumber terbuka, berfokus pada terminal, dan berteknologi AI yang dibangun dengan Tauri 2 + Rust dan React 19. Terax memiliki backend PTY native dengan perender WebGL, panel samping AI berbasis agen yang berjalan dengan kunci Anda sendiri atau model yang sepenuhnya lokal, serta editor kode, penjelajah berkas, kontrol sumber dengan grafik Git, dan panel pratinjau web. Sekitar 7-8 MB di disk. Tanpa telemetri. Tanpa akun.

## Tangkapan layar

<table>
  <tr><td align="center"><img src="../web-preview.png" alt="Pratinjau web" /><br/><sub>Pratinjau web server pengembangan lokal</sub></td><td align="center"><img src="../ai-workflow.png" alt="Jendela AI" /><br/><sub>Alur kerja AI berbasis agen dengan diff penyuntingan di editor kode</sub></td></tr>
  <tr><td align="center"><img src="../themes.png" alt="Tema dan gambar latar" style="margin-top: 12px;"/><br/><sub>Tema kustom, preset, dan gambar latar</sub></td><td align="center"><img src="../source-control.png" alt="Kontrol sumber dan grafik Git" style="margin-top: 12px;"/><br/><sub>Panel kontrol sumber dengan grafik Git dalam riwayat</sub></td></tr>
  <tr><td colspan="2" align="center"><img src="../terminal.png" alt="Terminal" style="border-radius: 4px; margin-top: 12px;" /><br/><sub>Terminal WebGL berbasis blok dengan panel masukan seperti editor</sub></td></tr>
</table>

## Fitur

### Terminal

- xterm.js dengan perender WebGL, multitab, dan streaming latar belakang
- Terminal berbasis blok dengan akselerasi GPU dan masukan perintah seperti editor
- Backend PTY native melalui `portable-pty` (zsh, bash, pwsh, fish, cmd)
- Panel terbagi secara horizontal dan vertikal
- Pencarian inline, deteksi tautan, dan true color
- Seret berkas dari penjelajah atau desktop ke terminal sebagai path yang dikutip secara aman untuk shell
- Lingkungan ruang kerja per tab di Windows (Local atau distribusi WSL apa pun yang terpasang)
- Spaces memulihkan tab, direktori kerja, dan tata letak terbagi pada peluncuran berikutnya

### Editor kode

- CodeMirror 6, mendukung bahasa populer seperti TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON, dan Markdown
- Pelengkapan otomatis AI inline dengan dukungan model lokal
- Diff penyuntingan AI yang dapat diterima atau ditolak per bagian
- Dukungan server bahasa opsional dengan diagnostik, navigasi, pelengkapan, pemformatan, dan server kustom
- Markdown terender serta tampilan gambar, video, audio, dan PDF
- Mode Vim
- Tema bawaan termasuk Kanagawa, Catppuccin, Rosé Pine, Everforest, Dracula, Solarized, Nord, Tokyo Night, GitHub, dan Xcode

### Kontrol sumber

- Stage / unstage bagian, commit (Cmd+Enter / Ctrl+Enter), dan push dengan kesadaran upstream
- Tampilan branch termasuk status detached HEAD
- Riwayat Git dengan grafik commit nyata dan jalur untuk merge serta branch
- Cari dan filter commit, lalu buka halaman commit remote

### Penjelajah berkas

- Tema ikon Catppuccin
- Pencarian fuzzy, navigasi keyboard, ganti nama inline, dan tindakan kontekstual
- Pembaruan langsung saat berkas berubah di disk
- Lampirkan berkas dan pilihan langsung ke panel samping AI

### Pratinjau web

- Mendeteksi server pengembangan lokal dan membukanya di tab pratinjau
- Pratinjau URL eksternal melalui WebView anak native

### Tema dan kustomisasi

- Buat tema kustom di aplikasi dan beralih antara preset bawaan dan tema Anda
- Bagikan tema atau impor dari komunitas
- Gambar latar dengan opasitas dan blur yang dapat disesuaikan
- Tema editor terpisah dari tema aplikasi

### AI

- **Penyedia dengan kunci Anda sendiri:** OpenAI, Anthropic, Google (Gemini), Groq, xAI (Grok), Cerebras, OpenRouter, DeepSeek, Mistral, dan endpoint apa pun yang kompatibel dengan OpenAI
- **Lokal / offline:** LM Studio, MLX, Ollama
- **Alur kerja berbasis agen:** rencana, subagen, memori proyek melalui `TERAX.md`, baca / tulis / sunting / multisunting / grep / glob, bash dengan persetujuan, dan proses latar belakang
- **Orkestrasi agen pemrograman:** jalankan Claude Code di terminal, periksa output, dan kirim pekerjaan lanjutan melalui alat yang memerlukan persetujuan
- **Komposer:** cuplikan prompt melalui `#handle`, berkas melalui `@path`, masukan suara, serta lampiran dari penjelajah atau pilihan
- **Agen kustom** dengan prompt sistem dan subset alat sendiri
- **Mode rencana** yang membuat rencana dan meminta konfirmasi sebelum bertindak

## Instalasi

> **Platform support (authoritative, English):** this fork builds and distributes Linux x86-64
> only, as an RPM and a DEB. macOS, Windows/WSL and Nix build and distribution support was
> removed, and no other architecture is produced. See the
> [English README](../../README.md#platform-support).

Install the RPM (`sudo dnf install ./terax-workspace-*.x86_64.rpm`) or the DEB (`sudo apt
install ./terax-workspace_*_amd64.deb`) from the
[Releases](https://github.com/crynta/terax-ai/releases/latest) page with your package manager.
Fedora 44 KDE Plasma on Wayland is the primary validation target; Debian 13 still needs an
actual graphical WebKitGTK session, and package install/upgrade validation is ticket #43.
`packaging/arch/PKGBUILD` carries an Arch recipe that is authored but **not built**, so it is
not a validated Arch claim. The application never downloads, installs or restarts itself.

On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

## Konfigurasi AI

1. Buka **Pengaturan -> AI**.
2. Pilih penyedia dan tempel kunci API. Untuk inferensi lokal, arahkan Terax ke endpoint LM Studio / MLX / Ollama.
3. Kunci disimpan di keychain sistem operasi melalui `keyring`. Kunci tidak pernah ditulis ke disk atau localStorage.

## Build dari sumber

**Prasyarat**

- Rust (stable), https://rustup.rs
- Node 22+ dan [pnpm](https://pnpm.io)
- Prasyarat Tauri untuk platform Anda, https://tauri.app/start/prerequisites/

**Jalankan**

```bash
pnpm install
pnpm tauri dev          # pengembangan
pnpm tauri build        # paket produksi
```

**Pemeriksaan**

```bash
pnpm lint
pnpm check-types
pnpm test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings   # lint Rust seperti CI
cd src-tauri && cargo nextest run --locked                           # atau cargo test --locked
```

## Stack teknologi

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, Vite, xterm.js, CodeMirror 6, Vercel AI SDK v6, Tailwind v4, shadcn/ui, dan Zustand.

## Berkontribusi

Issue dan PR dipersilakan. Laporkan masalah, sarankan fitur, atau kirim pull request. Lihat [CONTRIBUTING.md](../../CONTRIBUTING.md) dan [dokumentasi arsitektur](../README.md) untuk informasi lebih lanjut.

## Lisensi

Terax dilisensikan di bawah Apache-2.0. Untuk informasi tentang dependensi, lihat [Apache License 2.0](../../LICENSE).
