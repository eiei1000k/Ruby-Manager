<div align="center">

# 💎 Ruby Manager

**Ruby のバージョンと、リポジトリごとの Bundler を「見て」管理するデスクトップアプリ**

[![Release](https://img.shields.io/github/v/release/eiei1000k/Ruby-Manager?display_name=tag&sort=semver)](https://github.com/eiei1000k/Ruby-Manager/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Electron](https://img.shields.io/badge/built%20with-Electron-47848F?logo=electron&logoColor=white)

[ダウンロード](#ダウンロード) · [機能](#機能) · [対応環境](#対応しているバージョンマネージャ) · [トラブルシューティング](#トラブルシューティング) · [開発](#開発)

<img src="docs/screenshots/overview.png" alt="バージョンマップ: インストール済みの Ruby ごとに使用中のリポジトリを表示" width="860">

</div>

---

「このリポジトリはどの Ruby だったっけ？」「この Ruby はまだ使ってる？」「`bundle install` が通らないのは Ruby が違うから？」——
**Ruby Manager** は、rbenv や mise などの既存のバージョンマネージャの上で動き、手元の Ruby とリポジトリの関係を 1 画面で見えるようにします。

- 普段使っているバージョンマネージャは**そのまま**。置き換えたり、独自の場所に Ruby を入れたりしません
- `.ruby-version` や `Gemfile.lock` を読むだけで、リポジトリの状態を診断します
- 操作はすべて、実際に実行されるコマンドとログを表示します

## ダウンロード

[**Releases ページ**](https://github.com/eiei1000k/Ruby-Manager/releases/latest)から、お使いの OS 向けのファイルをダウンロードしてください。

| OS | ファイル | 備考 |
|---|---|---|
| **macOS** | `.dmg`（または `.zip`） | Apple シリコン / Intel |
| **Windows** | `Setup .exe`（インストーラ）/ ポータブル版 `.exe` | Windows 10 / 11 |
| **Linux** | `.AppImage` / `.deb` | x64 |

> [!NOTE]
> 現在のリリースはコード署名をしていません。初回起動時に OS の警告が出る場合は、以下の手順で開いてください。
>
> - **macOS**: アプリを右クリック →「開く」。または「システム設定 → プライバシーとセキュリティ」で「このまま開く」。
>   それでも開けない場合: `xattr -dr com.apple.quarantine "/Applications/Ruby Manager.app"`
> - **Windows**: SmartScreen の画面で「詳細情報」→「実行」
> - **Linux (AppImage)**: `chmod +x Ruby*.AppImage` で実行権限を付けてから起動。起動しない場合は `libfuse2` を入れてください
> - **Linux (deb)**: `sudo apt install ./ruby-manager_*.deb`

### 必要なもの

Ruby Manager 自体は Ruby を必要としませんが、Ruby をインストールするには、次のどれかのバージョンマネージャが入っている必要があります。

- **macOS / Linux**: [rbenv](https://github.com/rbenv/rbenv) + [ruby-build](https://github.com/rbenv/ruby-build)、[mise](https://mise.jdx.dev/)、[asdf](https://asdf-vm.com/)、[RVM](https://rvm.io/)、[ruby-install](https://github.com/postmodern/ruby-install) のいずれか
- **Windows**: [mise](https://mise.jdx.dev/) または [winget](https://learn.microsoft.com/windows/package-manager/winget/)（[RubyInstaller](https://rubyinstaller.org/) を導入）

どれも入っていなくても、システムの Ruby の表示とリポジトリの診断は使えます。

## 機能

### バージョンマップ

インストール済みの Ruby ごとに、それを使っているリポジトリを並べて表示します。

- 🔴 **赤い点線の行** — リポジトリが要求しているのに、まだインストールされていない Ruby（その場でインストール可能）
- **未使用** — どのリポジトリも使っていない Ruby（削除候補）
- **EOL / セキュリティ保守 / 保守中** — 公式のサポート期間に基づくバッジ
- **点線のリポジトリ** — バージョン指定ファイルがなく、グローバル設定に頼っているリポジトリ

### リポジトリの診断と Ruby の切り替え

<img src="docs/screenshots/project-issues.png" alt="リポジトリ詳細: 必要な Ruby が未インストールであることを検出" width="860">

次のファイルを突き合わせて、不整合を見つけます。

| 確認するもの | 例 |
|---|---|
| `.ruby-version` / `.tool-versions` / `mise.toml` | 指定された Ruby がインストールされているか、ファイル同士が食い違っていないか |
| Gemfile の `ruby "~> 3.3"` | 使用中の Ruby が要件を満たしているか |
| `Gemfile.lock` の `RUBY VERSION` | lock を作った Ruby とシリーズが違わないか |
| `Gemfile.lock` の有無 | `bundle install` をまだ実行していないか |

プルダウンで Ruby を選んで「このリポジトリに適用」を押すと、既存のバージョンファイルを書き換えます（なければ `.ruby-version` を作ります）。

### Bundler の管理

<img src="docs/screenshots/bundle-log.png" alt="Bundler パネルと bundle check の実行ログ" width="860">

コマンドは常に**そのリポジトリが使う Ruby**で実行されるので、シェルでの Ruby の切り替えを気にする必要はありません。

- `bundle install` / `check` / `update` / `outdated` / `lock` / `clean` をボタンで実行し、ログをリアルタイムで表示
- `Gemfile.lock` の `BUNDLED WITH` と同じバージョンの Bundler が入っているかを確認し、なければワンクリックでインストール
- gem のインストール先を `vendor/bundle` に分離 / Ruby 共有に戻す
- lockfile のプラットフォーム（`x86_64-linux`、`arm64-darwin`、`x64-mingw-ucrt` など）を追加・削除。CI や Docker 用に Linux を足すときに便利です

**Gems タブ**では `Gemfile.lock` を解析して、直接依存と間接依存、Gemfile の要件、Git ソースを一覧にします。「outdated を確認」を押すと、更新できるバージョンが表に追加され、gem ごとに `bundle update` できます。

### Ruby のインストール・削除・グローバル切り替え

<table>
<tr>
<td><img src="docs/screenshots/rubies.png" alt="インストール済み Ruby の一覧"></td>
<td><img src="docs/screenshots/install.png" alt="インストールできる Ruby の一覧"></td>
</tr>
</table>

- インストールできるバージョンをシリーズごとに表示（赤枠 = 各シリーズの最新安定版、緑 = インストール済み）
- クリックでインストールを開始し、ビルドログを表示
- グローバルの Ruby を切り替え、使っていない Ruby を削除
- 「詳細・gem」で、その Ruby の RubyGems のバージョン、Bundler のバージョン、インストール済み gem の一覧を表示し、`gem install` もできます

### リポジトリの登録

サイドバーの「＋ リポジトリを追加」からフォルダを選びます。**親フォルダ（例: `~/git`）を選ぶと、配下の Ruby リポジトリをまとめて登録**します。登録してもリポジトリのファイルは変更されません。

## 対応しているバージョンマネージャ

| マネージャ | macOS | Linux | Windows | 一覧 | インストール / 削除 | グローバル切替 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| rbenv + ruby-build | ✓ | ✓ | – | ✓ | ✓ | ✓ |
| mise | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| asdf | ✓ | ✓ | – | ✓ | ✓ | ✓ |
| RVM | ✓ | ✓ | – | ✓ | ✓ | ✓ |
| chruby + ruby-install | ✓ | ✓ | – | ✓ | ✓ | `~/.ruby-version` |
| RubyInstaller（winget） | – | – | ✓ | ✓ | ✓（シリーズ単位） | – |
| システム / Homebrew の Ruby | ✓ | ✓ | – | ✓ | – | – |

複数のマネージャが同時に入っていても、すべての Ruby をまとめて表示します。

## トラブルシューティング

<details>
<summary><b>バージョンマネージャが検出されない</b></summary>

macOS / Linux では、起動時にログインシェル（`$SHELL -il`）から環境変数を読み込みます。`rbenv init` や `mise activate` を `.zshrc` / `.bashrc` / `.bash_profile` に書いているか確認し、右上の「⟳ 再スキャン」を押してください。
Windows では、マネージャのコマンドが PATH に入っている必要があります。インストール直後はアプリを再起動してください。
</details>

<details>
<summary><b>インストールできるバージョンの一覧が古い・空になる</b></summary>

一覧は各マネージャから取得しています。ビルド定義を更新してください。

- rbenv: `brew upgrade ruby-build` または `git -C "$(rbenv root)"/plugins/ruby-build pull`
- asdf: `asdf plugin update ruby`
- RVM: `rvm get stable`
</details>

<details>
<summary><b>Ruby のビルドに失敗する</b></summary>

ログに表示されたエラーを確認してください。多くの場合、ビルドに必要なライブラリ（OpenSSL、libyaml、readline など）が不足しています。各マネージャのドキュメント（例: [ruby-build の推奨ビルド環境](https://github.com/rbenv/ruby-build/wiki#suggested-build-environment)）を参照してください。
</details>

<details>
<summary><b>登録したリポジトリの一覧はどこに保存される？</b></summary>

`projects.json` に保存されます。消すと登録がリセットされます。

- macOS: `~/Library/Application Support/Ruby Manager/`
- Windows: `%APPDATA%\Ruby Manager\`
- Linux: `~/.config/Ruby Manager/`
</details>

## プライバシー

Ruby Manager は利用状況やデータを外部に送信しません。ネットワークにアクセスするのは、あなたが実行した操作（Ruby のインストール、インストールできるバージョンの取得、`bundle install` / `outdated` など）が呼び出すコマンドだけです。

## 開発

Node.js 20 以上が必要です。

```sh
git clone https://github.com/eiei1000k/Ruby-Manager.git
cd Ruby-Manager
npm install
npm start      # アプリを起動
npm test       # Gemfile.lock パーサとバージョン判定のテスト
```

### パッケージのビルド

```sh
npm run dist:mac     # .dmg / .zip
npm run dist:win     # NSIS インストーラ / ポータブル .exe
npm run dist:linux   # AppImage / .deb
```

成果物は `dist/` に出力されます。各 OS 向けのパッケージは、その OS 上でビルドしてください。

### ディレクトリ構成

```
src/
├── main/
│   ├── main.js       Electron メインプロセス、IPC、ジョブ（コマンド）の実行
│   ├── managers.js   バージョンマネージャごとのアダプタ
│   ├── project.js    リポジトリの解析（バージョンファイル・Gemfile・.bundle/config）
│   ├── lockfile.js   Gemfile.lock と bundle outdated の出力のパーサ
│   ├── versions.js   バージョン比較・要件判定・サポート期間（EOL）の表
│   └── exec.js       コマンド実行、ログインシェルの環境変数の取得
├── preload.js        レンダラーに公開する API
└── renderer/         UI（HTML / CSS / JavaScript、フレームワークなし）
test/                 node:test によるテスト
```

新しいバージョンマネージャに対応するには、`src/main/managers.js` にアダプタ（`detect` / `list` / `getGlobal` / `setGlobal` / `listRemote` / `installCmd` / `uninstallCmd` / `execCmd`）を追加して、`ALL` に登録します。

Ruby のサポート期間は `src/main/versions.js` の `EOL` 表で管理しています。新しいブランチが出たら、[公式のブランチ保守状況](https://www.ruby-lang.org/ja/downloads/branches/)に合わせて更新してください。

## コントリビュート

Issue や Pull Request を歓迎します。Pull Request を送る前に `npm test` が通ることを確認してください。UI を変更した場合は、スクリーンショットを添えてもらえると助かります。

## ライセンス

[MIT](LICENSE) © eiei1000k
