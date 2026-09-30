# 執筆指示ベンチマーク

**[本文を左右に並べて読む（HTML）](comparison.html)**。HTMLはダウンロードしてブラウザで開く。GitHub上では下の課題別リンクから、全文・初稿・採点理由をMarkdownで読める。

実行開始: 2026-09-20T11:59:47.232Z。対象: origin/main / ca1c0eb501cd5885dde28c6a84a1438dd42232a6。

生成: gpt-5.6-luna / low、評価: gpt-5.6-terra / low。10課題 × 2反復 × 2条件。

| 指標 | スキルなし | スキルあり |
|---|---:|---:|
| 評価基準の合格数 | 78/100 | 76/100 |
| 全5基準合格の出力 | 10/20 | 5/20 |
| facts | 20/20 | 15/20 |
| grounding | 13/20 | 15/20 |
| role | 14/20 | 17/20 |
| clarity | 20/20 | 18/20 |
| economy | 11/20 | 11/20 |
| 初稿lint合格 | 13/20 | 16/20 |
| 最終稿lint合格 | 13/20 | 19/20 |
| 最終稿lint指摘数 | 17 | 1 |
| 平均本文文字数 | 439.3 | 310.6 |
| 生成呼び出し数（修正含む） | 20 | 24 |
| 入力トークン（cache込み） | 50898 | 353827 |
| 内cache入力トークン | 17920 | 21504 |
| 出力トークン | 7786 | 10773 |
| 平均生成時間・秒（修正含む） | 12.6 | 19.8 |

## 課題別

各セルは反復ごとの合格基準数（5点満点）。

| 課題 | なし | あり |
|---|---|---|
| ADRの判断と作業追跡の分離 | 2, 2 | 4, 2 |
| Design Docの構成・失敗条件・代替案 | 2, 2 | 4, 4 |
| 進捗報告で追跡情報を保持 | 5, 5 | 4, 4 |
| 障害記録の時系列と仮説 | 5, 4 | 5, 5 |
| 資料不足の手順を完成扱いしない | 5, 3 | 3, 5 |
| 既存文書の一文だけ修正 | 5, 5 | 4, 4 |
| 正本で済む依頼 | 5, 5 | 3, 3 |
| 文書を作る必要性の判断 | 4, 4 | 4, 1 |
| RFCで比較と未決定を保つ | 2, 3 | 4, 3 |
| 曖昧な表現を根拠に沿って具体化 | 5, 5 | 5, 5 |

## 本文・初稿・採点理由を読む

各比較には、原依頼、両条件の最終稿全文、注記、5基準の判定理由、修正前の初稿とlint指摘を収めている。本文だけのMarkdownにも移動できる。

- ADRの判断と作業追跡の分離: [1回目](comparisons/adr-boundary.1.md)、[2回目](comparisons/adr-boundary.2.md)。
- Design Docの構成・失敗条件・代替案: [1回目](comparisons/design-tradeoff.1.md)、[2回目](comparisons/design-tradeoff.2.md)。
- 進捗報告で追跡情報を保持: [1回目](comparisons/progress-retention.1.md)、[2回目](comparisons/progress-retention.2.md)。
- 障害記録の時系列と仮説: [1回目](comparisons/incident-record.1.md)、[2回目](comparisons/incident-record.2.md)。
- 資料不足の手順を完成扱いしない: [1回目](comparisons/runbook-missing.1.md)、[2回目](comparisons/runbook-missing.2.md)。
- 既存文書の一文だけ修正: [1回目](comparisons/surgical-edit.1.md)、[2回目](comparisons/surgical-edit.2.md)。
- 正本で済む依頼: [1回目](comparisons/canonical-reference.1.md)、[2回目](comparisons/canonical-reference.2.md)。
- 文書を作る必要性の判断: [1回目](comparisons/no-document.1.md)、[2回目](comparisons/no-document.2.md)。
- RFCで比較と未決定を保つ: [1回目](comparisons/comparison-rfc.1.md)、[2回目](comparisons/comparison-rfc.2.md)。
- 曖昧な表現を根拠に沿って具体化: [1回目](comparisons/plain-japanese.1.md)、[2回目](comparisons/plain-japanese.2.md)。

## 解釈の範囲

これはSKILL.mdと関連資料を明示的に付与する比較であり、スキルの自動発火、親子エージェントの委譲、意味確認からの修正、モデル昇格は測っていない。lint修正の条件は実行時のmanifest.jsonを参照する。旧実行は両条件に指摘を返したため、スキルの有無による比較として扱わない。新しい実行系はスキルなし側に指摘を返さないが、モデル入力の分離は別途検証が必要である。意味基準は最終稿だけを採点する。

判定は条件名を伏せ、A/Bの位置を均衡化した単一LLMによるもの。人間の盲検評価ではなく、採点の誤りと同系モデルの傾向が残る。課題は作成者がPRの狙いから選んだ10種で、うちADR・進捗・不足手順・部分修正は既存の動作確認を別の題材にした。独立したホールドアウトや40種全体の代表標本ではない。反復数は課題ごとの揺れを観測するもので、基準数を独立標本として扱わない。有意差・一般的な優位・金額の削減率は主張しない。

文字数だけでは品質を判定しない。トークンはCLI報告の実測値で、入力はcacheを含む。時間は並列実行・接続・cacheの影響を含む。評価モデルの利用量はsummary.jsonのjudgeUsageに別計上する。
