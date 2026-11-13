<!-- fork-copy: upstream translation; the authoritative description of this build is ../../README.md -->

> [!IMPORTANT]
> この翻訳は上流の Terax のものです。このフォークは、ここで説明されている組み込み AI 機能（チャット、自動補完、AI による変更レビュー、プロバイダーと API キーの設定）を削除しました。このリポジトリが配布するビルドについては [`README.md`](../../README.md) を参照してください。

<div align="center">
  <img src="../../public/logo.png" width="144" height="144" alt="Terax" />
  <h1>Terax</h1>
  <p><strong>軽量でターミナル中心の AI ネイティブ開発ワークスペース。</strong></p>
  <p><a href="https://terax.app">ウェブサイト</a> · <a href="https://terax.app/docs">ドキュメント</a> · <a href="https://github.com/crynta/Terax-website">ウェブサイトのソースコード</a></p>

  <p>
    <img src="https://img.shields.io/github/v/release/crynta/terax-ai?label=version&color=blue" alt="バージョン" />
    <img src="https://img.shields.io/github/downloads/crynta/terax-ai/total?label=downloads&color=blue" alt="ダウンロード" />
    <img src="https://img.shields.io/badge/platform-Linux%20x86_64-lightgrey" alt="プラットフォーム" />
    <a href="https://discord.gg/tyveTUyEp7"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://www.youtube.com/@crynta"><img src="https://img.shields.io/badge/Youtube-FF0000?logo=youtube&logoColor=white" alt="YouTube" /></a>
  </p>
</div>

<p align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | <a href="README.ko.md">한국어</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.pl.md">Polski</a> | <a href="README.ru.md">Русский</a> | <a href="README.id.md">Bahasa Indonesia</a> | <a href="README.hi.md">हिन्दी</a>
</p>

---

Terax は、Tauri 2 + Rust と React 19 で構築された、軽量かつオープンソースのターミナル中心 AI ネイティブ開発環境（ADE）です。WebGL レンダラーを備えたネイティブ PTY バックエンド、自分のキーまたは完全なローカルモデルで動作するエージェント型 AI サイドパネル、コードエディター、ファイルエクスプローラー、Git グラフ付きソース管理、ウェブプレビューパネルを内蔵しています。ディスク使用量は約 7-8 MB。テレメトリなし。アカウント不要。

## スクリーンショット

<table>
  <tr><td align="center"><img src="../web-preview.png" alt="ウェブプレビュー" /><br/><sub>ローカル開発サーバーのウェブプレビュー</sub></td><td align="center"><img src="../ai-workflow.png" alt="AI ウィンドウ" /><br/><sub>コードエディター内の編集差分を伴うエージェント型 AI ワークフロー</sub></td></tr>
  <tr><td align="center"><img src="../themes.png" alt="テーマと背景画像" style="margin-top: 12px;"/><br/><sub>カスタムテーマ、プリセット、背景画像</sub></td><td align="center"><img src="../source-control.png" alt="ソース管理と Git グラフ" style="margin-top: 12px;"/><br/><sub>履歴に Git グラフを備えたソース管理パネル</sub></td></tr>
  <tr><td colspan="2" align="center"><img src="../terminal.png" alt="ターミナル" style="border-radius: 4px; margin-top: 12px;" /><br/><sub>エディターのような入力パネルを備えたブロック型 WebGL ターミナル</sub></td></tr>
</table>

## 機能

### ターミナル

- WebGL レンダラー、マルチタブ、バックグラウンドストリーミング対応の xterm.js
- エディターのようなコマンド入力を備えた GPU アクセラレーション対応ブロック型ターミナル
- `portable-pty` によるネイティブ PTY バックエンド（zsh、bash、pwsh、fish、cmd）
- 水平および垂直の分割パネル
- インライン検索、リンク検出、True Color
- エクスプローラーやデスクトップからファイルをドラッグし、シェルで安全に引用されたパスとして入力
- Windows のタブごとのワークスペース環境（Local またはインストール済みの WSL ディストリビューション）
- Spaces がタブ、作業ディレクトリ、分割レイアウトを次回起動時に復元

### コードエディター

- CodeMirror 6（TS/JS、Rust、Python、Go、C/C++、Java、HTML/CSS、JSON、Markdown など主要言語に対応）
- ローカルモデル対応のインライン AI 自動補完
- AI 編集差分をハンク単位で承認または拒否
- 診断、ナビゲーション、補完、フォーマット、カスタムサーバーに対応したオプトインの言語サーバー
- Markdown のレンダリングと画像、動画、音声、PDF の表示
- Vim モード
- Kanagawa、Catppuccin、Rosé Pine、Everforest、Dracula、Solarized、Nord、Tokyo Night、GitHub、Xcode などの内蔵テーマ

### ソース管理

- ハンクのステージ / アンステージ、コミット（Cmd+Enter / Ctrl+Enter）、上流を認識したプッシュ
- Detached HEAD 状態を含むブランチ表示
- マージとブランチのレーンを描画する実際のコミットグラフ付き Git 履歴
- コミットの検索と絞り込み、リモートのコミットページへの移動

### ファイルエクスプローラー

- Catppuccin アイコンテーマ
- あいまい検索、キーボード操作、インライン名前変更、コンテキスト操作
- ディスク上のファイル変更をリアルタイムに反映
- ファイルや選択範囲を AI サイドパネルへ直接添付

### ウェブプレビュー

- ローカル開発サーバーを自動検出してプレビュータブで開く
- ネイティブ子 WebView による外部 URL のプレビュー

### テーマとカスタマイズ

- アプリ内でカスタムテーマを作成し、内蔵プリセットと切り替え
- テーマの共有やコミュニティからのインポート
- 不透明度とぼかしを調整できる背景画像
- エディターテーマはアプリテーマから独立

### AI

- **BYOK プロバイダー:** OpenAI、Anthropic、Google（Gemini）、Groq、xAI（Grok）、Cerebras、OpenRouter、DeepSeek、Mistral、任意の OpenAI 互換エンドポイント
- **ローカル / オフライン:** LM Studio、MLX、Ollama
- **エージェント型ワークフロー:** 計画、サブエージェント、`TERAX.md` によるプロジェクトメモリ、ファイルの読み取り / 書き込み / 編集 / 複数編集 / grep / glob、承認付き bash、バックグラウンドプロセス
- **コーディングエージェントの連携:** ターミナルで Claude Code を起動し、出力を確認して、承認付きツールから追加作業を送信
- **コンポーザー:** `#handle` のプロンプトスニペット、`@path` のファイル、音声入力、エクスプローラーや選択範囲からの添付
- 独自のシステムプロンプトとツールセットを持つ**カスタムエージェント**
- 実行前に計画を生成して確認する**プランモード**

## インストール

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

## AI の設定

1. **設定 -> AI** を開きます。
2. プロバイダーを選び API キーを貼り付けます。ローカル推論では LM Studio / MLX / Ollama エンドポイントを指定します。
3. キーは `keyring` を通して OS のキーチェーンに保存されます。ディスクや localStorage には一切書き込まれません。

## ソースからビルド

**前提条件**

- Rust（stable）、https://rustup.rs
- Node 22+ と [pnpm](https://pnpm.io)
- プラットフォームごとの Tauri 前提条件、https://tauri.app/start/prerequisites/

**実行**

```bash
pnpm install
pnpm tauri dev          # 開発
pnpm tauri build        # 本番バンドル
```

**チェック**

```bash
pnpm lint
pnpm check-types
pnpm test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings   # CI と同じ Rust lint
cd src-tauri && cargo nextest run --locked                           # または cargo test --locked
```

## 技術スタック

Tauri 2、Rust、`portable-pty`、React 19、TypeScript、Vite、xterm.js、CodeMirror 6、Vercel AI SDK v6、Tailwind v4、shadcn/ui、Zustand。

## コントリビューション

Issue と PR を歓迎します。問題の報告、機能提案、Pull Request を送信できます。詳しくは [CONTRIBUTING.md](../../CONTRIBUTING.md) と[アーキテクチャ文書](../README.md)を参照してください。

## ライセンス

Terax は Apache-2.0 ライセンスです。依存関係については [Apache License 2.0](../../LICENSE) を参照してください。
