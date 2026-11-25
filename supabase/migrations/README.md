# Supabase migrations

このディレクトリには、接続中のSupabaseプロジェクトの適用済みSQLを保存します。
適用履歴のバージョン番号とファイル名を一致させて管理します。

- 2026-11-19までの25件: 2026-11-23の調査時点でDBに適用済みのSQL
- `20261123101725_spot_import_redesign_phase1.sql`: Phase 1マイグレーション。2026-11-23に無料開発プロジェクトへ適用済み
- `20261123102705_admin_only_facility_retry.sql`: 施設単位エラー再開をシステム管理者に限定するRPC。2026-11-23に無料開発プロジェクトへ適用済み
- `20261123102825_expose_job_pipeline_version.sql`: ジョブ一覧RPCへpipeline_versionを追加。2026-11-23に無料開発プロジェクトへ適用済み
- `20261123103234_add_spot_import_reevaluation_staging.sql`: 再評価結果の一時保存列とWorker専用保存RPCを追加。2026-11-23に無料開発プロジェクトへ適用済み
- `20261123194300_remove_unused_spot_import_reevaluation.sql`: 再評価機能を実装対象外としたため、上記の専用列・RPCを削除。2026-11-23に無料開発プロジェクトへ適用済み

## 未適用

- `20261125000100_facility_recovery_separate_execution.sql`: 施設単位の再実行を通常ジョブから分離し、親ジョブを `completed / human_review` のまま維持する変更。2026-11-25時点では開発ブランチに追加しただけで、Supabase無料開発プロジェクトには未適用。適用前にSQLレビュー・検証を行う。

## 注意

- Phase 1の適用先はSupabaseプロジェクト `fugibstqzkmzplqrpovn` です。
- DBの適用履歴バージョンは `20261123101725` です。ファイル名も同じバージョンに揃えています。
- 適用時点で存在したジョブ6件はすべて `legacy_v1` に固定され、新規ジョブだけ `redesign_v1` を既定値とします。
- 試験データの削除はまだ実施していません。
- 本番環境への適用は別途レビュー・判断します。

旧ブランチにあった別バージョンのSQLは `docs/legacy-migrations/` に内容を変更せず保管しています。
そちらは現在のDB適用履歴と一致しないため、再適用しないでください。
- `20261123203000_persist_sitemap_queue_and_safe_redirects.sql`: サイトマップを専用キューに保存し、Cron実行ごとに継続取得できるようにする。許可ドメイン内のHTTPSリダイレクトも追跡。2026-11-23に無料開発プロジェクトへ適用済み
