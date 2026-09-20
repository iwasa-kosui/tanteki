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

掲載する結果は `benchmark.json` で指定します。`format` が `legacy` なら `index.html`、`isolated` なら `isolated.html` を使います。見た目は `styles.css`、操作は `site.js` で管理します。ビルド結果の `dist/` はコミットしません。

比較は `examples.json` で対象と強調する文字列を指定します。`before.highlight` と `after.highlight` は、`text`（強調する文字列）と `note`（その箇所の注釈）を持つオブジェクトの配列です。強調した箇所の直下に `note` の本文を常時表示します。ビルド時に保存済みの生成文書の全文を取得するため、引用本文を複製して管理する必要はありません。出典が見つからないとき、`text` と `note` のいずれかが空のときはビルドが失敗します。`text` が文書内に見つからないときと、2回以上現れるときも失敗します。重複するときは、より長い文字列を指定して一意にします。比較は同じ版からの独立した生成結果であり、順次の改稿履歴ではありません。注釈には、改善だけでなく不足や両条件の共通点も記載します。

比較欄は初めから全文を表示します。長い文書は各欄の中でスクロールできます。キーボードでは欄にフォーカスを移して矢印キーなどを使います。

分離方式の紹介ページには、使用例の比較条件と原文・評価へのリンクを掲載します。集計値は全件の比較画面 `evaluation.html` で確認できます。原文・評価・入力の記録は `results/` に保存します。現在は分離方式の `benchmarks/results/2026-09-21-docker-13f60c3/` を参照しています。

`npm run lint:site` は、ビルドで抽出した紹介文 `.cache/site-copy.md` を検査します。原文の引用と依頼文は保持し、解説文は通常の本文として検査します。文章の意味と出典の照合は別途必要です。

## 分離方式の結果へ切り替える

[分離方式の手順](../benchmarks/isolated/README.md)で生成と採点を完了し、公開用の保存先へ書き出します。出力先は未作成のディレクトリを指定します。

```sh
npm run benchmark:publish -- \
  --run .cache/benchmark-generation \
  --evaluation .cache/benchmark-grade \
  --out benchmarks/results/YYYY-MM-DD-docker-COMMIT
```

書き出し時に、確定した生成記録・全呼び出し記録・採点結果のハッシュを照合します。公開用には本文、採点、実行設定、初回入力、事前検証、コンテナ設定を保存します。全呼び出し記録はローカルに保持し、公開用にはファイルごとのハッシュ一覧を残します。ハッシュは変更の検知用で、第三者の署名ではありません。

`benchmark.json` の `format` を `isolated`、`run` を書き出した保存先に変更します。`examples.json` の引用と注釈も新しい原文へ合わせます。`repeat` で反復を指定でき、省略すると1回目です。本文の引用・採点結果・集計値・実行条件を照合してから、ビルドと文章検査を行います。

本文と判定を照合した所見を、公開用の保存先に `run-notes.md` として置くと、サイトから参照できます。モデルの採点結果は保持し、判定への異論は所見へ記します。

ビルド時にも公開データのハッシュと、両条件の入力・環境の一致を検査します。失敗した試行は集計と全件比較に残します。紹介例に失敗した試行を指定した場合はビルドを止めます。旧方式の用途レビューは新方式の出力へ引き継ぎません。

## 公開

リポジトリの Settings → Pages → Build and deployment で、Source を **GitHub Actions** に設定します。初回もこの設定が必要です。

変更が `main` にマージされると、`.github/workflows/pages.yml` がビルドと文章検査を行い、`dist/` を公開します。PR ではビルドと検査だけを行います。公開予定先は [tanteki](https://iwasa-kosui.github.io/tanteki/) です。

設定の詳細は [GitHub Pages の公式手順](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)を参照してください。
