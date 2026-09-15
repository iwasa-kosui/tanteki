# nihongo-de-ok

日本語の業務・技術文書を執筆・推敲するエージェントスキルです。設計の理由、制約、例外を残して、短く分かりやすく整えます。

## インストール

[GitHub CLI](https://cli.github.com/) 2.90以降とNode.js 22以降が必要です。

```sh
gh skills install iwasa-kosui/nihongo-de-ok tanteki --scope user
```

対話画面で利用するエージェントを選ぶと、個人用の配置先にインストールされます。`--agent claude-code`、`--agent codex`、`--agent cursor` などで指定することもできます。詳細は[インストールの公式手順](https://cli.github.com/manual/gh_skill_install)を参照してください。

文書検査に必要な依存関係は、初回利用時にエージェントがスキルの配置先で `npm ci` を実行して導入します。

## 使い方

インストール後にエージェントの新しいセッションを開き、読者と目的を添えて依頼します。

```text
tanteki を使って、この設計書を開発者向けに短く推敲して。
実現方式と不採用案の理由、制約、例外は残して。

（ここに草稿を貼る）
```

詳しくは[スキルの手順](SKILL.md)、[CLIでの検査](references/lint.md)、[出力の比較](benchmarks/results/2026-09-06-main-fb6fd0b/document-review/report.md)を参照してください。

## 設計の参考

[ponytail](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md)の「成立する最小の手段で止める」を文書に応用しました。常時有効化やコード専用の出力制約は引き継いでいません。

[MIT License](LICENSE)
