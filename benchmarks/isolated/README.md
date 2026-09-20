# 分離環境でのスキル比較

同じユーザー入力を、新しいDockerコンテナで条件ごとに実行する。変更するのはtanteki一式の導入だけ。スキルなしの生成に採点用textlintを適用したり、採点結果を渡して書き直させたりしない。

旧方式は[執筆指示の付与実験](../README.md)として保存する。旧結果と、この方式の結果は分けて読む。

## 比較の単位と検証

課題・反復ごとにスキルあり／なしを1ペアにする。両側のジョブJSON、ユーザー入力のバイト列、モデル、推論量、出力形式、制限時間、呼び出し上限を一致させる。順序はseedで決め、各課題で先に実行する条件を反復ごとに交替する。モデル出力自体は固定しない。

| 項目 | スキルなし | スキルあり |
|---|---|---|
| 実行イメージ | 同じイメージID | 同じイメージID |
| HOME・作業領域 | 毎回空のtmpfs | 毎回空のtmpfs |
| 有効なスキル | 0件 | tantekiのみ |
| tantekiの資料・textlint | 配置しない | lockに記録した一式を配置 |
| 生成中のツール | 共通のツール | 共通のツール |
| 完了後の採点 | 別コンテナ | 別コンテナ |

Codex自身のスキル一覧と解決済み設定を取得し、期待と違えばモデルを呼ばずに停止する。組み込みスキルは両条件とも無効化する。ユーザーのHOME、リポジトリ、AGENTS.md、認証情報、他の試行、隠した採点基準はマウントしない。

「同じプロンプト」はユーザー入力の完全一致を指す。スキルありではCodexがスキルの発見情報を追加するため、モデルに届く全コンテキストは異なる。実際の初回APIリクエストも保存し、スキル一覧、メッセージID、セッションのメタデータ、キャッシュキー以外の差があればペアを無効にする。日付などの環境情報が途中で変わった場合も無効になる。

コンテナは外部ネットワークなし、ルート領域は読み取り専用で動かす。CodexとそのコマンドはUID 1000で実行する。モデル通信は標準入出力を介してホストから固定のResponses APIへ中継する。APIキーはホストだけが持ち、過去の会話IDの使用やモデルの変更を拒否する。画像・Web・外部サービスへのアクセスを伴う課題は、この方式の対象外。

## 実行

Node.js 22以上とDockerを用意し、リポジトリで`npm ci`を実行する。ホストのCodex設定やログイン状態は使わない。イメージのビルドにはネットワークが必要。コンテナ内はNode.js 24でTSを直接実行する。

```sh
npm ci
npm run typecheck:benchmark
npm test

# 配布スキルを編集した場合は、先にnpm run package:skillを実行する。
# 出力先は毎回新しいディレクトリを指定する。
npm run benchmark -- build --out .cache/benchmark-build

# 入力・順序の確認だけ。APIキーは不要。
npm run benchmark -- generate \
  --lock .cache/benchmark-build/runtime-lock.json \
  --model MODEL --dry-run

# OPENAI_API_KEYをホストの環境変数に設定して実行する。
# この生成はAPIの利用料金を消費する。
npm run benchmark -- generate \
  --lock .cache/benchmark-build/runtime-lock.json \
  --out .cache/benchmark-generation --model MODEL

# 全出力を確定した後、採点を別に実行する。採点もAPIを利用する。
npm run benchmark -- grade \
  --run .cache/benchmark-generation \
  --out .cache/benchmark-grade --model JUDGE_MODEL

# 保存結果からHTMLと集計を再生成する。モデル呼び出しなし。
npm run benchmark -- report \
  --run .cache/benchmark-generation \
  --evaluation .cache/benchmark-grade --out .cache/benchmark-report
```

`MODEL`と`JUDGE_MODEL`には、利用アカウントのResponses APIで使えるモデルを指定する。モデルが利用できなければ失敗し、代替モデルへ切り替えない。Codex CLIは既定で0.155.1に固定する。`--codex-version`で変更できるが、変更後は下記の結合テストで互換性を確認する。

生成の既定値は10課題、2反復、推論量low、各試行600秒、最大24回のモデルリクエスト。`--cases adr-boundary,progress-retention`、`--repeats`、`--effort`、`--timeout`、`--max-model-calls`で変更できる。独自課題は`--cases-file`で指定する。採点は1ペアにつきモデルリクエスト1回。生成中の子エージェントの呼び出しも同じ上限に含める。

中断した実行は未確定のまま残す。再開や条件片側だけの再試行は行わず、新しい出力先でペアを実行し直す。全試行が終わると、失敗を含む結果を確定する。記録、入力、コードのハッシュが一致しない結果は採点できない。

## 結果の読み方

`comparison.html`で本文を左右に比較する。`report.md`に状態別の件数と合否、`summary.json`にペアごとの点数差を保存する。スキルを読まなかった試行やlintを使わなかった試行も残す。品質の比較には両条件が有効なペアだけを使い、環境無効・実行失敗は件数と理由を表示する。

生成中の「スキル本文取得」「lintコマンド実行」はログから確認する。lintは直接のコマンド呼び出しを数える。ラッパー経由の実行は検出できない場合がある。スキルの遵守や、すべてのファイルアクセスの証明ではない。完了後の採点用lintは別の指標として表示する。失敗した呼び出しで利用量が返らなければ、そのトークン数は不明となる。

意味の採点には原依頼、事前に決めた基準、A/B候補の本文と注記を渡す。実行条件名、ツールログ、lint結果は渡さない。既存の基準に本文外の草稿表示を認めるものがあるため、注記も採点対象に含める。候補の内容から条件を推測できる場合があり、完全な盲検ではない。LLM判定の根拠は人が確認する。

生成側には`private/cases.json`を渡さず、ジョブに`prompt`だけを取り出す。`calls/`には実際のAPIリクエスト、イベント、事前検証、コンテナ設定を保存する。生成記録の確定後にファイルが変わった場合は採点を拒否する。ハッシュは変更の検知用であり、第三者による署名ではない。

## 動作検証

```sh
# Dockerと本物のCodexを使い、API応答だけを模擬する。APIキー・課金なし。
npx tsx benchmarks/isolated/smoke.ts \
  .cache/benchmark-build/runtime-lock.json .cache/benchmark-smoke
```

結合テストは、異なるコンテナID、同一入力、スキルなしでのtextlint不在、ホスト環境変数の不在、入力の読み取り専用、スキルありでの本文取得とlint実行を確認する。その後、別の採点、API失敗時のコンテナ削除、確定結果の変更検知も確認する。模擬応答によるテストなので、文章品質やスキルの自然な発火率は測らない。

## 実装の見取り図

新しいベンチマークはTypeScriptで実装する。Zodで外部入力を検証し、workerの失敗はneverthrowのResultで返す。HTMLのMarkdown描画には既存の描画関数を共用する。

| ファイル | 役割 |
|---|---|
| `worker.ts` | 準備、事前検証、実行、終了処理を順に呼ぶ |
| `turn-state.ts` | 副作用のない状態遷移 |
| `turn-event.ts` | Codex通知を状態遷移の入力へ変換する |
| `codex-session.ts` | スキル一覧と設定の検証、ターンの実行 |
| `codex-client.ts` | CodexとのJSON-RPC通信 |
| `worker-environment.ts` | 空の環境の確認、設定作成、プロセス起動 |
| `model-relay.ts` | コンテナ内HTTPと標準入出力の中継 |
| `docker.ts` | ホスト側のコンテナ管理とAPI通信 |
| `protocol.ts` | 入力、環境、ペアの一致検査 |
| `cli.ts` | build、generate、grade、reportの進行 |
