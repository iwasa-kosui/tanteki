# 開発

スキルの正本はルートの `SKILL.md` と、その参照資料・検査スクリプトです。`skills/tanteki/` は `gh skills` で配布するための生成物なので、正本を編集してから再生成します。

```sh
npm ci
npm run package:skill
npm run check:skill-package
npm test
npm run lint:docs
```

正本と生成物を同じコミットに含めてください。CIは生成物の不足・変更・余分なファイルを検出します。
