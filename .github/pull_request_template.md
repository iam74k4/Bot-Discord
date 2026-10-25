<!--
develop 向けの通常PRテンプレートです。
リリース（develop → main）は ?template=release.md を付けて作成してください:
https://github.com/iam74k4/Bot-Discord/compare/main...develop?template=release.md
-->

## 概要

<!-- 何を・なぜ変えたか。関連 Issue があれば記載 -->

## 変更内容

-

## 確認方法

- [ ] `bash scripts/validate.sh` が通る（CI と同じチェック）
- [ ] staging（テストサーバー）で動作確認する / した
<!-- 確認したコマンドや手順を書くとレビューが速くなります -->

## 影響チェック

該当するものにチェックし、詳細を書いてください。リリース時にまとめて確認します。

- [ ] DB マイグレーションを追加・変更した（毎起動で再実行されても安全か確認済み）
- [ ] テーブルや列を**削除・作り直す**マイグレーションがある（ロールバック不可 → リリースPRで明記）
- [ ] 環境変数を追加・変更した（`.env.example` と `docs/deployment.md` を更新済み）
- [ ] Gateway Intents（特権 Intent を含む）や Bot の権限が変わる
- [ ] スラッシュコマンドの追加・名前変更・削除がある
- [ ] 依存パッケージを追加・更新した
- [ ] 該当なし

## スクリーンショット

<!-- UI（Embed・パネル・メッセージ）が変わる場合 -->
