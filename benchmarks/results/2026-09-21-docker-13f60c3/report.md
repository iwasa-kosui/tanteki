# 分離スキルベンチマーク

[本文と実行状態の左右比較](comparison.html)

同じユーザー入力でtanteki一式の導入効果を比較する。生成中にスキルが行った検査・改稿は含む。採点のtextlint結果は生成へ返さない。未発火も集計に残し、品質は両側が有効なペアで評価する。取得・コマンドの観測はログからの推定であり、スキルの遵守や全ファイルアクセスの証明ではない。失敗時にプロバイダーが利用量を返さなかった呼び出しのトークン数は不明。

状態: 採点済み。有効ペア 16/20、採点済みペア 16。

| 指標 | スキルなし | スキルあり |
|---|---:|---:|
| 計画した実行 | 20 | 20 |
| 環境検証済み | 18 | 17 |
| 環境無効 | 0 | 0 |
| 実行失敗 | 2 | 3 |
| 本文取得をログで観測 | 0 | 16 |
| lintコマンドをログで観測 | 0 | 5 |
| 採点対象 | 16 | 16 |
| 採点用lint合格 | 8 | 15 |
| モデル呼び出し（失敗含む） | 22 | 85 |
| 入力トークン（報告された全実行分） | 118397 | 954302 |
| 出力トークン（報告された全実行分） | 12545 | 28749 |
| 意味基準合格 | 60/80 | 71/80 |

品質の差はケースと反復ごとのペアで読む。モデル出力の決定性や一般的な優位は保証しない。

- plain-japanese.1.with_skill: execution_failed — Provider failure: rate_limit_exceeded

- plain-japanese.1.without_skill: execution_failed — Provider failure: rate_limit_exceeded

- no-document.1.with_skill: execution_failed — Provider failure: rate_limit_exceeded

- canonical-reference.1.with_skill: execution_failed — Provider failure: rate_limit_exceeded

- comparison-rfc.1.without_skill: execution_failed — Provider failure: rate_limit_exceeded
