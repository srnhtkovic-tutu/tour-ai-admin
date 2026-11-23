# Supabase migrations

このディレクトリには、2026-11-23に接続中のSupabaseプロジェクトの
`supabase_migrations.schema_migrations` から取得した適用済みSQLと、
このブランチで追加した未適用SQLを保存します。

- 2026-11-19までの25件: 現在のDBに適用済みのSQLをそのまま同期したもの
- `20261123150000_spot_import_redesign_phase1.sql`: この作業ブランチで作成した未適用の変更

## 注意

`20261123150000_...` はまだ本番DBへ適用していません。
適用前に、SQLのレビュー・テスト・実行環境の確認を行います。

旧ブランチにあった別バージョンのSQLは `docs/legacy-migrations/` に内容を変更せず保管しています。
そちらは現在のDB適用履歴と一致しないため、再適用しないでください。
