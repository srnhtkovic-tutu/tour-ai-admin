# スポット収集・統合機能の実装ベースライン

- 取得日: 2026-11-23
- 保存先ブランチ: `feature/spot-import-redesign-2026-11`
- 対象Supabase project ref: `fugibstqzkmzplqrpovn`
- 目的: 新設計への改修前に、現在デプロイされているEdge FunctionのソースをGitHubに保全する。
- 原本保存先: `docs/legacy-edge-functions/`（Supabaseから取得した未改変スナップショット）
- 作業用ソース: `supabase/functions/`（新設計に合わせた改修対象）
- 注意: このフォルダのコードは取得時点の現行コードのスナップショットであり、新設計への改修はまだ加えていない。Supabase本番環境には変更を加えていない。

## 保存したFunction

原本は `docs/legacy-edge-functions/` に別途保全し、作業用ファイルを変更しても原本を上書きしない。

- `supabase/functions/spot-import-dispatcher/index.ts` — Supabase version 14, 20645 chars
- `supabase/functions/collect-spot-import-urls-worker-v2/index.ts` — Supabase version 7, 13847 chars
- `supabase/functions/extract-spot-page-candidates-worker-v2/index.ts` — Supabase version 9, 17097 chars
- `supabase/functions/analyze-spot-import-batch-worker-v2/index.ts` — Supabase version 8, 10145 chars
- `supabase/functions/merge-spot-information-v2-worker/index.ts` — Supabase version 12, 37597 chars

## 実装上の主要な差分（調査時点）

1. 現行Dispatcherの工程は `url_collection → page_extraction → candidate_analysis → information_merge`。
2. 新設計では、施設名抽出後の旧 `candidate_analysis` 工程を廃止し、ABCD評価と情報統合を分離する。
3. 現行の情報統合Workerは、ABCD評価結果を `spot_import_merged_v2.relevance_results`、進捗を `relevance_progress` に保存している。
4. 現行の関連ページ選定はタイトル・本文のILIKE検索、ID順の取得、独自priority順であり、新設計の完全一致・収集順の要件と差がある。
5. 現行の80,000文字選定は上限超過ページをスキップして後続ページを続ける。新設計は最初に収まらないページが出た時点で選定を終了する。
6. 現行の住所取得は候補テーブルから行っている。新設計ではA/B/Cページ本文からGeminiが確認できた住所を取得する。
7. 本番DB・本番Edge Functions・Cronには変更を加えていない。
8. DB適用済みマイグレーション25件を `supabase/migrations/` に同期し、旧ブランチの未適用・別バージョンSQL 10件は `docs/legacy-migrations/` に保全した。
9. `20261123150000_spot_import_redesign_phase1.sql` は作業ブランチ上の未適用SQLであり、本番DBには適用していない。

## 2026-11-23 実装反映記録（ベースライン取得後）

上記は改修前の取得時点の記録です。その後、次の変更を作業ブランチと無料開発プロジェクトへ反映しました。

- `merge-spot-information-v3-worker` をSupabaseへデプロイ（version 1）。作業ブランチのソースとデプロイ済みソースの一致を確認。
- `spot-import-dispatcher` を二重経路対応版へ更新（version 15）。作業ブランチのソースとデプロイ済みソースの一致を確認。
- Phase 1マイグレーション `20261123101725` を適用。
- 既存6ジョブはすべて `legacy_v1`。新規ジョブの既定値は `redesign_v1`。
- Cronは3分間隔で有効、実行ロックは `unlocked`。
- 既存試験データの削除と、新方式の新規ジョブ実行はまだ行っていない。
- `public.spots` のRLS無効は既存のセキュリティ課題として残っており、今回の作業では変更していない。
