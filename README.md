# Ruby Manager

Ruby のバージョンと、リポジトリごとの Bundler / gem を **視覚的に** 管理するデスクトップアプリ（Windows / macOS / Linux）。

## 機能

- **バージョンマップ** — インストール済み Ruby ごとに、どのリポジトリが使っているかを一覧表示。未インストールの要求バージョン・未使用（削除候補）・EOL がひと目で分かる
- **Ruby のインストール / 削除 / グローバル切替** — rbenv(ruby-build)・mise・asdf・RVM・ruby-install・winget(RubyInstaller) に対応。ビルドログはリアルタイム表示
- **リポジトリ診断** — `.ruby-version` / `.tool-versions` / `mise.toml` / Gemfile の `ruby` 指定 / `Gemfile.lock` の `RUBY VERSION` を突き合わせて不整合を検出
- **リポジトリごとの Ruby 切替** — プルダウンで選ぶだけでバージョンファイルを書き換え
- **Bundler 管理** — `bundle install / check / update / outdated / lock / clean`、`BUNDLED WITH` の Bundler 自動インストール、`vendor/bundle` への分離、lockfile のプラットフォーム追加・削除
- **Gem 一覧** — Gemfile.lock を解析し、直接/間接依存・Gemfile 要件・更新可能バージョンを表示。gem 単位で update
- **Ruby ごとの gem 一覧** と `gem install`

親フォルダ（例: `~/git`）を追加すると、配下の Ruby リポジトリをまとめて登録します。

## 対応するバージョンマネージャ

| マネージャ | macOS | Linux | Windows | インストール |
|---|---|---|---|---|
| rbenv + ruby-build | ✓ | ✓ | – | ✓ |
| mise | ✓ | ✓ | ✓ | ✓ |
| asdf | ✓ | ✓ | – | ✓ |
| RVM | ✓ | ✓ | – | ✓ |
| chruby + ruby-install | ✓ | ✓ | – | ✓ |
| RubyInstaller (winget) | – | – | ✓ | ✓ |
| システム / Homebrew Ruby | ✓ | ✓ | – | 表示のみ |

コマンドは、各 Ruby の `bin` を PATH の先頭に置いた環境で実行されます（RVM は `rvm <ver> do`）。
GUI から起動しても PATH が正しくなるよう、macOS/Linux ではログインシェルの環境変数を読み込みます。

## 開発

```sh
npm install
npm start          # 起動
npm test           # パーサ・バージョン判定のテスト
```

## 配布用ビルド

```sh
npm run dist:mac    # .dmg / .zip
npm run dist:win    # NSIS インストーラ / portable .exe
npm run dist:linux  # AppImage / .deb
```

各 OS のパッケージは、基本的にその OS 上でビルドしてください（CI なら OS ごとのランナーを使用）。

## 構成

```
src/main/main.js      Electron メインプロセス・IPC・ジョブ実行
src/main/managers.js  各バージョンマネージャのアダプタ
src/main/project.js   リポジトリ解析（バージョンファイル・Gemfile）
src/main/lockfile.js  Gemfile.lock / bundle outdated パーサ
src/main/versions.js  バージョン比較・要件判定・EOL 情報
src/main/exec.js      コマンド実行・シェル環境の取得
src/preload.js        レンダラーに公開する API
src/renderer/         UI（HTML/CSS/JS、フレームワーク不使用）
```

EOL 日付は `src/main/versions.js` の表で管理しています（公式のブランチ保守情報に合わせて更新してください）。
