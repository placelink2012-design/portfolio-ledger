# Portfolio Ledger

CSVから複数取引所（みんなのFX / 松井証券 / bitbank / GMOコイン）の取引・入出金データを取り込み、
現金＋現物を合算したポートフォリオ構成・損益推移・銘柄別チャートを表示する、自分専用の投資分析ツールです。

## データの保存場所について（重要）

このアプリはブラウザの **localStorage** にデータを保存します。つまり:

- データは **この端末・このブラウザだけ** に保存されます（他の端末とは自動的に同期されません）
- 別の端末でも使いたい場合は、アプリ内「データ取込」タブ下部の **バックアップを書き出す / 読み込む** を使って、
  JSONファイルを手動で移してください
- ブラウザのキャッシュ・データを消去すると、保存内容も消えます。定期的にバックアップを取ることをおすすめします

## GitHub Pagesで公開する手順

1. このフォルダの中身（`docs/` を含む）をGitHubリポジトリにpushしてください
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
   git push -u origin main
   ```
2. GitHubのリポジトリページで **Settings → Pages** を開く
3. 「Build and deployment」の **Source** を `Deploy from a branch` にする
4. **Branch** を `main`、フォルダを `/docs` に設定して **Save**
5. 数分後、`https://<あなたのユーザー名>.github.io/<リポジトリ名>/` でアクセスできるようになります

## コードを変更してビルドし直す場合

```bash
npm install
npm run build   # docs/bundle.js を再生成します
```

`src/App.jsx` がアプリ本体、`src/storage-polyfill.js` がClaude Artifacts専用の
保存機能をブラウザのlocalStorageで代替している部分です。
