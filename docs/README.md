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

比較は `examples.json` で対象と強調する文字列を指定します。`before.highlight` と `after.highlight` は、`text`（強調する文字列）と `note`（その箇所の注釈）を持つオブジェクトの配列です。強調した箇所の直下に `note` の本文を常時表示します。ビルド時に保存済みの生成文書の全文を取得するため、引用本文を複製して管理する必要はありません。出典が見つからないとき、`text` と `note` のいずれかが空のときはビルドが失敗します。`text` が文書内に見つからないときと、2回以上現れるときも失敗します。重複するときは、より長い文字列を指定して一意にします。比較は同じ版からの独立した生成結果であり、順次の改稿履歴ではありません。注釈には、改善だけでなく不足や両条件の共通点も記載します。

比較欄は初めから全文を表示します。長い文書は各欄の中でスクロールできます。キーボードでは欄にフォーカスを移して矢印キーなどを使います。

集計値も保存済みの評価から取得します。用途のレビューと、固定5基準の採点・生成量は別の表に表示します。全件の比較画面を `evaluation.html` として同梱し、原文・評価・入力の記録を `results/` に保存します。モデルに渡した入力の検査が全件通った実行だけをビルドします。出典は `benchmarks/results/2026-09-20-isolated-ca1c0eb/` です。

`npm run lint:site` は、ビルドで抽出した紹介文 `.cache/site-copy.md` を検査します。原文の引用と依頼文は保持し、解説文は通常の本文として検査します。文章の意味と出典の照合は別途必要です。

## 公開

リポジトリの Settings → Pages → Build and deployment で、Source を **GitHub Actions** に設定します。初回もこの設定が必要です。

変更が `main` にマージされると、`.github/workflows/pages.yml` がビルドと文章検査を行い、`dist/` を公開します。PR ではビルドと検査だけを行います。公開予定先は [tanteki](https://iwasa-kosui.github.io/tanteki/) です。

設定の詳細は [GitHub Pages の公式手順](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)を参照してください。
