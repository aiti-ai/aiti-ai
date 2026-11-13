# AITI Web — 公式 Docker イメージ（core / full）

[English](https://github.com/aiti-ai/aiti-ai/blob/main/docker/README.md) | [中文](https://github.com/aiti-ai/aiti-ai/blob/main/docker/README.zh-CN.md) | 日本語 | [Русский](https://github.com/aiti-ai/aiti-ai/blob/main/docker/README.ru.md)

**AITI Web**（`@aiti-ai/pi-web`）は、[pi コーディングエージェント](https://github.com/earendil-works/pi) 向けのブラウザワークベンチです。上流の [pi-web](https://github.com/agegr/pi-web) からフォークされ、独自のディストリビューション **aiti** へと成長したもので、日常使用のために作られています。63 以上のバンドル拡張機能（セッション & キュー、git ツールチェーン、ページ注入デバッグ、マルチエージェントバックエンド、トンネル、音声）が最初から同梱され、個別インストールは不要。エンジンは pi のままです（JSONL セッション共有、同一のローカル設定）。

このイメージは、そのすべてを動かす最速の方法です。pi-web + 全バンドル拡張 + pi エンジン + Node/git + aiti-bridge を 1 コンテナに収め、`full` はさらにウェブデスクトップ（noVNC、Chrome/CDP）、音声、トンネルを追加します。フォークの経緯：[aiti.pw/guide/origin.html](https://aiti.pw/guide/origin.html)。

ドキュメント：[aiti.pw](https://aiti.pw/)（EN / 中文）· ソース：[aiti-ai/aiti-ai](https://github.com/aiti-ai/aiti-ai) · npm がお好みなら：`npm i -g @aiti-ai/pi-web` · ライセンス：[MIT](https://github.com/aiti-ai/aiti-ai/blob/main/LICENSE)

---

# 使用マニュアル

> イメージ：`aitiai/pi-web:core`（ベース、2.13GB）/ `aitiai/pi-web:full`（オールインワン、7.76GB）。

## 1. クイックスタート

```bash
# ベースイメージ：http://localhost:30144 でワークベンチを開く
docker run -d --name aiti --init \
  -p 30144:30142 \
  -v aiti_data:/opt/aiti/data \
  -v aiti_agent:/opt/aiti/agent \
  -v ~/my-project:/workspace \
  aitiai/pi-web:core
```

- 初回起動：サイドバー「プロジェクトを選択 → デフォルトディレクトリを使用」（= /workspace）→「新規セッション」→ 下部の「設定」でモデルキーを設定 → チャット開始。
- データは 2 つのボリュームに保存されます：`aiti_data`（拡張機能のランタイムデータ）と `aiti_agent`（pi セッション / モデル設定）——**イメージをアップグレードしてもデータは保持されます**。
- ⚠ `/opt/aiti` のサブパスのみをマウントしてください。**`/opt/aiti` 全体をマウントしないでください**：名前付きボリュームは初回のみ投入されるため、ルートをマウントするとイメージのアップグレードが永久に無効になります（テストレポート O22 参照）。

## 2. イメージの選択

| | core | full |
|---|---|---|
| サイズ | 2.13GB | 7.76GB |
| pi-web + バンドル拡張 + pi エンジン + justget + bridge | ✅ | ✅ |
| GUI（Xvfb/VNC/noVNC/Chrome+CDP） | — | ✅ |
| ASR 音声認識（funasr 4 モデル、:8767） | — | ✅ |
| TTS edge-tts / ウェブ端末 ttyd（:7681） | — | ✅ |
| トンネル cloudflared/ngrok/frpc | — | ✅ |
| メモリ下限 | 1GB | **8GB**（full + 音声；2–6GB では OOM） |

full の追加フェーズは `AITI_PHASES` で制御します（§4 参照）。

## 3. ポート

| ポート | サービス | デフォルト |
|---|---|---|
| 30142 | pi-web メイン UI | 必須マップ |
| 8777 | aiti-bridge（ページ注入 / MCP / エージェント REST） | 外部エージェント / 注入使用時にマップ |
| 8767 | ASR WS/HTTP（full） | full でデフォルト有効；必要に応じてマップ |
| 6080 | noVNC ウェブデスクトップ（full） | ループバックのみ、必要に応じてマップ |
| 5900 | VNC（full） | ループバックのみ |
| 9222 | Chrome CDP（full） | ループバックのみ |
| 7681 | ttyd ウェブ端末（full） | ループバックのみ |

`AITI_PIWEB_PORT` / `AITI_BRIDGE_PORT` でコンテナ側ポートを変更できます（稀なケース）。

## 4. 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `AITI_PHASES` | `piweb,bridge` | カンマ区切り：`piweb,bridge,gui,asr,term`。gui/asr/term は full のみ実装（core はログを出してスキップ） |
| `PUID`/`PGID` | 1000 | 実行 uid/gid（ホストユーザーに合わせるとマウントしたディレクトリがそのまま使えます）。⚠ `UID` は使用不可（bash の読み取り専用組み込み変数） |
| `TZ` | UTC | 例：`Asia/Shanghai` |
| `AITI_PIWEB_PORT` / `AITI_BRIDGE_PORT` | 30142 / 8777 | コンテナ側ポート；HEALTHCHECK が自動追従 |
| `AITI_MODE` | auto | `core`/`full`/`auto`（イメージ層マーカー基準）；full イメージに core を設定するとベースフェーズにダウングレード |
| `AITI_DEV` | 0 | `1` = ソースをマウントして `next dev` をホットリロードで実行（開発モード） |
| `AITI_SKIP_CHOWN` | 0 | `1` = `--user` で直接起動する際に root 初期化をスキップ |
| `AITI_GUI_NOFILE` | 65536 | GUI セッションの fd 上限（増やさないこと——大きな NOFILE は x11vnc をデッドロックさせます、テストレポート O20） |
| `AITI_GUI_SIZE` | 1920x1080x24 | 仮想ディスプレイ解像度 |

### ドメイン / リバースプロキシ（pi-web と同じセマンティクス）

| 変数 | 説明 |
|---|---|
| `PI_WEB_ALLOWED_HOSTS` | 信頼するホスト名（カンマ区切り）——リバースプロキシのドメインは**必ず**列挙してください。未列挙は 403。列挙外ホストは拒否され続けます（Host ゲートは維持） |
| `PI_WEB_BASE_DOMAIN` | service-tunnels の公開 URL を組み立てるドメイン（`host:port`） |
| `AITI_BASE_URL` | aiti-devtools 注入ページ / MCP の公開ベース URL（プロキシ URL を設定） |
| `API_ALLOW_ORIGINS` | ブリッジ CORS（`*` または明示オリジン；プロキシドメインが提供元オリジンと異なる場合に必要） |
| `PI_WEB_EXTRA_EXTENSIONS_DIRS` | 追加拡張ディレクトリ（コンテナ内パス、カンマ区切り；`-v` マウントと併用してユーザー拡張を追加） |

リバースプロキシ例（ドメイン → `127.0.0.1:30144`、ブリッジ → `18777`）：

```bash
docker run -d --name aiti --init \
  -p 127.0.0.1:30144:30142 -p 127.0.0.1:18777:8777 \
  -e PI_WEB_ALLOWED_HOSTS="pi.example.com,aiti.pi.example.com" \
  -e PI_WEB_BASE_DOMAIN="pi.example.com:8443" \
  -e AITI_BASE_URL="https://aiti.pi.example.com:8443" \
  -e API_ALLOW_ORIGINS="*" \
  -v aiti_data:/opt/aiti/data -v aiti_agent:/opt/aiti/agent \
  aitiai/pi-web:core
```

実測挙動（テストレポート T-E/T-H）：列挙済み Host は 200、未列挙は 403。`*.pi.example.com` のワイルドカード + ワイルドカード証明書の下でのサブドメイン追加は追加作業不要。

## 5. ボリュームと永続化

| マウント | 内容 | 推奨 |
|---|---|---|
| `/opt/aiti/data` | 拡張機能のランタイムデータ（設定ストア / インデックス / キャッシュ） | 名前付きボリューム |
| `/opt/aiti/agent` | pi セッション JSONL / models.json / mcp-cache | 名前付きボリューム（**生命線——必ず永続化**） |
| `/workspace` | ワークスペース（起動時のデフォルト cwd；pi セッションはプロジェクトごとにグループ化） | ホストのプロジェクトディレクトリをバインドマウント |
| `/home/aiti/.pi` | **任意**：ホストの pi 設定を継承 | 初回実行で auth.json/models.json を採用；settings.json は組み込みデフォルトと jq マージ（ユーザーキー優先、packages は和集合） |
| `/opt/aiti/extensions` | 拡張コード | **マウントしない**——イメージ層が所有；アップグレードでイメージと共に更新 |

## 6. full イメージの機能一覧

| 機能 | エントリーポイント |
|---|---|
| ウェブデスクトップ | noVNC `:6080/vnc.html`（websockify→x11vnc→Xvfb :99 経由の RFB） |
| CDP デバッグ | Chrome `:9222`（headful、`--user-data-dir=/opt/aiti/data/chrome-profile`） |
| 音声入力 | ASR `ws://<host>:8767/ws/stream`（リアルタイム）/ `/voice/quick`（クイック）/ `/voice/transcribe`（高精度）/ `/ws/vad`（セグメンテーション）——aiti-ai-input 拡張が `AITI_ASR_STREAM_BASE` 経由で自動接続 |
| 音声読み上げ | edge-tts 同梱；aiti-ai-speek 拡張で `tts.edge` feature を有効化 |
| ウェブ端末 | ttyd `:7681` |
| トンネル | コンテナ内で `cloudflared` / `ngrok` / `frpc` が利用可能（ngrok は自分の authtoken が必要） |
| ダウンロードツール | `justget <url> -o <file> -m <mirror-url>` マルチソースレーシング |

## 7. 運用

```bash
docker logs -f aiti                 # ログ（拡張の準備状況 / ブリッジ / バナーはすべてここ）
docker exec -it aiti bash           # コンテナに入る（ユーザー aiti、パスワードなし sudo）
docker stats aiti                   # リソース
docker inspect aiti --format '{{.State.Health.Status}}'   # healthy = 正常
docker stop aiti && docker rm aiti  # 停止 & 削除（ボリュームは保持）
docker volume rm aiti_data aiti_agent   # データも削除（要注意）
```

- **グレースフル停止**：`docker stop` は約 1 秒で終了（エントリーポイントが各サービスへシグナルを転送）。
- **アップグレード**：新しいイメージを `docker pull` し、コンテナを削除して再作成（同名ボリュームがデータを運搬）；拡張はイメージと共に更新。
- **再ビルド + スモーク**：`./docker/scripts/rebuild-and-smoke.sh core full`（CI 対応；終了コード = 失敗数）。

## 8. ビルドと公開（メンテナー向け）

```bash
# CN 以外のネットワーク / GitHub CI：公式ミラーを直接使用
./docker/build.sh --target core --tag aitiai/pi-web:core
./docker/build.sh --target full --tag aitiai/pi-web:full     # core が先に必要

# CN ローカルビルド：--cn でミラーを注入（apt=tuna / npm=npmmirror / hf=hf-mirror / pypi=tuna）
./docker/build.sh --target core --tag aitiai/pi-web:core --cn
# 等価 env：AITI_CN=1（systemd unit テンプレートに事前設定済み）

./docker/scripts/smoke.sh full [--keep]                  # 22 項目のスモークスイート（終了コード = 失敗数）
node docker/scripts/e2e-ui.mjs                           # UI 体験 E2E（playwright-core + chromium が必要）
node docker/scripts/gen-deps.mjs                         # S3 依存マトリクス（拡張の `aiti` メタデータブロックを読む）
```

> `--cn` は公開ソースのミラーのみに影響します。**`@aiti-ai/*` プライベートレジストリは別の一時チャネル**：`--private-registry <プライベートレジストリ URL>`（または env `AITI_PRIVATE_REGISTRY`）——ローカルテスト専用。`@aiti-ai/*` が公開 npm に載れば省略でき、公式レジストリが使われます。
> 実行時も同様：`docker run -e AITI_NPM_REGISTRY=<プライベートレジストリ URL>` で pi が初回起動時にプライベートパッケージを取得できます（コンテナ内 `~/.npmrc` に書き込み）。
> 既知の制限（テストレポートの残課事項参照）：arm64 には公式 Chrome なし（CDP 不可；他のダウンロード層は準備完了）；ngrok/frpc のダウンロードは時々リトライが必要（ビルドは gh-mirror レーシングフォールバック付き）；UI E2E はホスト chromium に依存。

## 9. トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| コンテナが再起動ループ | `docker logs` で最初のエラーを確認；大抵はポート競合 / ボリューム権限（PUID を合わせる） |
| リバースプロキシ 403 | ドメインが `PI_WEB_ALLOWED_HOSTS` にない |
| `/api/models` 403 | 正常——既存セッション cwd のみ許可；ヘルスチェックは `/api/home` を使用 |
| x11vnc は接続するが画面が出ない /極端に遅い | NOFILE デッドロック（O20）——`AITI_GUI_NOFILE` が上げられていないことを確認し、イメージ同梱の 50-gui-start を使用 |
| CDP 9222 に到達しない | フラグに `--user-data-dir` があることを確認（Chrome 136+ はデフォルトプロファイルで CDP を無視）+ 初回 EULA スキップ済み |
| ASR の初回応答が遅い | モデルは遅延ロード（full はモデルを事前ダウンロード済み、再ダウンロードゼロ；モデル切替は増分ダウンロード） |
| OOM | full + 音声には ≥8GB メモリが必要（実測 2–6GB で OOM、テストレポート T-H5） |
