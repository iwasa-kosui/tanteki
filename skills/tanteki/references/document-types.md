# IT 現場の文書分類（方針案）

これは、日本の IT 現場でエンジニアと PdM が文書の役割を選ぶための方針案である。日本全国の統一規格を定めるものではない。文書名は組織によって異なるため、名前ではなく読者・目的・保存すべき情報で分類する。

## 区分

- **stock**: 後から現状、契約、設計、要求、判断を参照するための基準情報。更新やレビューの有無では区分を変えない。PRD、Design Doc、RFC、ADR はこの区分に置く。
- **flow**: 計画、作業、進捗、現在進行中の運用を調整するための文書。完了・変更後に正本となる情報は、必要に応じて stock または record に移す。
- **record**: 起きたこと、行われた判断、調査結果、障害の経過を後から追えるよう保存する記録。作業の進捗を管理するものではない。

## 役割を決める

以下の節の表から、探している種別の行だけ読む。執筆前に次を短く決める。これは作業用メモであり、成果物へ必ず挿入する項目ではない。

- 種別と区分: `prd` / `design-doc` / `adr` / `rfc` / `stock` / `flow` / `record`
- 読者: 誰が、何を知っているか。
- 目的: 読後に何を判断・実行できるか。
- 目的外: この文書で管理しないこと。
- 根拠: 参照する資料と、まだ分からないこと。

資料を確認してから形式を選ぶ。重大な不足だけ質問し、未確認の数値、承認、仕様を補わない。確認待ちでも書ける部分は進める。組織の呼び名が表になければ、この5点で役割を定める。

`stock` に進捗、PR番号、Jira課題IDを入れない。追跡は作業文書側から設計・判断を参照する。ADR の採用・廃止・置換、判断日、別 ADR への参照や、仕様の業務状態は残す。`flow` と `record` に必要な日付、担当、時系列、課題参照を機械的に削除しない。

見出しを埋めるために書かない。以下は必要情報の目安であり、節の数や順序の指定ではない。読者に必要なら増やし、短文で揃うならまとめる。情報ごとに節を作ったり、項目名を見出しに列挙したりせず、[文書全体の構成](structure.md#文書全体の構成を決める)に沿ってまとめ方を決める。

## カテゴリから参照先を引く

書く文書のカテゴリを決め、該当するファイルだけを読む。7つのファイルを続けて読まない。

| カテゴリ | 含む種別 | 参照先 |
|---|---|---|
| 戦略・プロダクト | ビジョン・戦略、Product Brief、PRD、ロードマップ | [strategy](types/strategy.md) |
| 調査・分析 | 問題定義、顧客調査、分析結果、実験計画、環境調査 | [research](types/research.md) |
| 要求・仕様 | 要求仕様、ユーザーストーリー、ユースケース、機能仕様、非機能要求、API 仕様 | [requirements](types/requirements.md) |
| 設計・意思決定 | Design Doc、RFC、ADR、脅威モデル、データモデル設計 | [design](types/design.md) |
| QA・リリース | テスト計画、テスト結果、受け入れテスト手順書、リリース計画、データ移行計画 | [qa-release](types/qa-release.md) |
| 運用・障害 | Runbook、SLI/SLO 方針、インシデント記録、ポストモーテム、廃止告知 | [operations](types/operations.md) |
| 知識・計画・記録 | プロジェクト計画、進捗報告、会議メモ、確認依頼、README、ガイド、FAQ | [knowledge](types/knowledge.md) |

## CLI profile との対応

静的検査 CLI の `--type` は、書き手が種別を宣言するための名前である。`prd`、`design-doc`、`adr`、`rfc`、`stock` の5つは同じ検査を行い、`flow` と `record` は作業進捗の検査を外す。名前ごとに検査の内容が変わるわけではない。

チェックボックスや PR 番号を本文へ持つ文書では `flow` か `record` を選ぶ。受け入れテスト手順書のように、チェックボックスが本文の一部になる文書をストック文書として検査すると、すべてのチェックボックスが作業進捗として指摘される。

profile 名を文書の状態や作業進捗と解釈しない。

## 参考資料

以下は文書の役割を考える際に参照した一次資料であり、上表の stock/flow/record 区分そのものを定める外部規格ではない。

- [Google Documentation Best Practices](https://google.github.io/styleguide/docguide/best_practices.html) — Design Doc/PRD は実装案へのフィードバックに使い、実装後は判断のアーカイブとして扱うという指針。
- [Michael Nygard, Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) — ADR を重要な判断の文脈・決定・結果として短く記録する原典。
- [RFC 2026: The Internet Standards Process](https://www.rfc-editor.org/rfc/rfc2026) — RFC、Internet-Draft、標準化段階、文書の正式状態を区別する資料。
