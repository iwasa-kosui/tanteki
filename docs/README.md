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

比較は `examples.json` で対象と抜粋する節を指定します。ビルド時に保存済みの生成文書から抜き出すため、引用本文を複製して管理する必要はありません。出典の節や強調する文字列が見つからなければビルドは失敗します。比較は旧版の独立生成結果であり、順次の改稿履歴ではありません。

集計値も保存済みの評価から取得します。全件の比較画面を `evaluation.html` として同梱します。出典は `benchmarks/results/2026-09-06-main-fb6fd0b/` です。

`npm run lint:site` は、ビルドで抽出した紹介文 `.cache/site-copy.md` を検査します。原文の引用と依頼文は保持し、解説文は通常の本文として検査します。文章の意味と出典の照合は別途必要です。

## 公開

リポジトリの Settings → Pages → Build and deployment で、Source を **GitHub Actions** に設定します。初回もこの設定が必要です。

変更が `main` にマージされると、`.github/workflows/pages.yml` がビルドと文章検査を行い、`dist/` を公開します。PR ではビルドと検査だけを行います。公開予定先は [tanteki](https://iwasa-kosui.github.io/tanteki/) です。

設定の詳細は [GitHub Pages の公式手順](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)を参照してください。
