> **比較無効（2026-09-20）**: 「スキルなし」側にも tanteki の lint 指摘を返して修正させていたため、スキルの有無による比較としては無効です。表の条件名は実行時のラベルを残したもので、スキル非適用を保証しません。本文・判定・数値は検証用の記録です。

# 執筆指示ベンチマーク

**[本文を左右に並べて読む（HTML）](comparison.html)**。HTMLはダウンロードしてブラウザで開く。GitHub上では下の課題別リンクから、全文・初稿・採点理由をMarkdownで読める。

実行開始: 2026-09-05T16:59:30.140Z。対象: origin/main / fb6fd0b085bcd2b03ea8381709ae36d5f95d437e。

生成: gpt-5.6-luna / low、評価: gpt-5.6-terra / low。10課題 × 2反復 × 2条件。

| 指標 | スキルなし | スキルあり |
|---|---:|---:|
| 評価基準の合格数 | 79/100 | 93/100 |
| 全5基準合格の出力 | 8/20 | 13/20 |
| facts | 20/20 | 20/20 |
| grounding | 12/20 | 20/20 |
| role | 17/20 | 20/20 |
| clarity | 20/20 | 19/20 |
| economy | 10/20 | 14/20 |
| 初稿lint合格 | 13/20 | 19/20 |
| 最終稿lint合格 | 19/20 | 20/20 |
| 最終稿lint指摘数 | 2 | 0 |
| 平均本文文字数 | 406.1 | 210.9 |
| 生成呼び出し数（修正含む） | 27 | 21 |
| 入力トークン（cache込み） | 77981 | 228417 |
| 内cache入力トークン | 16128 | 14336 |
| 出力トークン | 12428 | 5934 |
| 平均生成時間・秒（修正含む） | 17.2 | 9.8 |

## 課題別

各セルは反復ごとの合格基準数（5点満点）。

| 課題 | なし | あり |
|---|---|---|
| ADRの判断と作業追跡の分離 | 3, 3 | 4, 4 |
| Design Docの構成・失敗条件・代替案 | 2, 4 | 5, 5 |
| 進捗報告で追跡情報を保持 | 5, 5 | 5, 5 |
| 障害記録の時系列と仮説 | 4, 5 | 5, 5 |
| 資料不足の手順を完成扱いしない | 4, 3 | 5, 4 |
| 既存文書の一文だけ修正 | 5, 5 | 4, 4 |
| 正本で済む依頼 | 5, 5 | 5, 5 |
| 文書を作る必要性の判断 | 4, 3 | 4, 5 |
| RFCで比較と未決定を保つ | 3, 2 | 4, 5 |
| 曖昧な表現を根拠に沿って具体化 | 4, 5 | 5, 5 |

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
