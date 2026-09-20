# 紹介サイトの保守

`docs/` は GitHub Pages 用の紹介サイトのソースです。Node.js 22以降を使います。

```sh
npm ci
npm run build:site
npm run lint:site
python3 -m http.server 4173 --bind 0.0.0.0 --directory dist
```

`http://localhost:4173` で確認できます。スマートフォンでは `mobile-preview-url 4173` が返す URL を開きます。

## 更新

ページの文章と構成は `index.html`、見た目は `styles.css`、操作は `site.js` で管理します。ビルド結果の `dist/` はコミットしません。

現在は比較結果の掲載を停止しています。「スキルなし」側にも tanteki の lint 指摘を返していたためです。9月20日と9月6日の実行を `benchmarks/invalidated-runs.json` に登録しました。スキルの有無による効果として、この結果を利用しません。

ビルドは無効化の告知を表示し、数値の比較表と使用前後の文書を掲載しません。`examples.json` の注釈は履歴として保持しますが、現在のビルドでは使いません。`evaluation.html` には、冒頭に無効化の告知を付けた検証用の記録を同梱します。出典は `benchmarks/results/2026-09-20-main-ca1c0eb/` です。

掲載を再開するには、モデル入力の分離を確認して再測定し、出典と紹介文を更新します。出典だけを差し替えた場合はビルドが失敗します。再測定はまだ実施していません。

`npm run lint:site` は、ビルドで抽出した紹介文 `.cache/site-copy.md` を検査します。原文の引用と依頼文は保持し、解説文は通常の本文として検査します。文章の意味と出典の照合は別途必要です。

## 公開

リポジトリの Settings → Pages → Build and deployment で、Source を **GitHub Actions** に設定します。初回もこの設定が必要です。

変更が `main` にマージされると、`.github/workflows/pages.yml` がビルドと文章検査を行い、`dist/` を公開します。PR ではビルドと検査だけを行います。公開予定先は [tanteki](https://iwasa-kosui.github.io/tanteki/) です。

設定の詳細は [GitHub Pages の公式手順](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)を参照してください。
