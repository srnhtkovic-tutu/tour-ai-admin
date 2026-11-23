import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 11/13基準の1ページ単位処理を維持する。
// 施設名の抽出はpage_extractionで完了しているため、ここではGeminiを呼び出さない。
const BATCH_SIZE = 1;

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POSTで実行してください。" }, 405);
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase接続設定が不足しています。" }, 500);
  }
  if (
    req.headers.get("authorization") !== `Bearer ${serviceRoleKey}` ||
    req.headers.get("apikey") !== serviceRoleKey
  ) return jsonResponse({ error: "認証に失敗しました。" }, 401);

  try {
    const body = await req.json();
    const jobId = cleanString(body.job_id);
    const executionId = cleanString(body.execution_id);
    const lockToken = cleanString(body.lock_token);
    if (!jobId || !executionId || !lockToken) {
      return jsonResponse({ error: "job_id、execution_id、lock_tokenが必要です。" }, 400);
    }

    const { data: job, error: jobError } = await supabase
      .from("spot_import_jobs")
      .select("id")
      .eq("id", jobId)
      .single();
    if (jobError) throw jobError;
    if (!job) throw new Error("対象ジョブを確認できません。");

    const { data: pages, error: claimError } = await supabase.rpc("worker_claim_url_batch", {
      p_job_id: jobId,
      p_execution_id: executionId,
      p_lock_token: lockToken,
      p_stage: "candidate_analysis",
      p_limit: BATCH_SIZE,
    });
    if (claimError) throw claimError;

    let pagesCompleted = 0;
    for (const page of (pages ?? [])) {
      // ②で保存済みの施設名候補を再抽出・再評価しない。
      // URL単位の工程完了だけを記録する。候補名と関連ページの確定は
      // ④の施設名一覧・ページ照合処理で行う。
      const { error: commitError } = await supabase.rpc("worker_commit_analysis_batch", {
        p_job_id: jobId,
        p_execution_id: executionId,
        p_lock_token: lockToken,
        p_url_id: page.id,
        p_success: true,
        p_candidates: [],
        p_error: null,
      });
      if (commitError) throw commitError;
      pagesCompleted++;
    }

    const { count, error: remainingError } = await supabase
      .from("spot_import_urls")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .eq("crawl_status", "fetched")
      .eq("candidate_extraction_status", "completed")
      .eq("analysis_status", "pending");
    if (remainingError) throw remainingError;

    const seenNames = new Set<string>();
    for (let offset = 0; ; offset += 1000) {
      const { data: candidateRows, error: candidateError } = await supabase
        .from("spot_import_page_candidates")
        .select("name,extraction_order")
        .eq("job_id", jobId)
        .order("extraction_order", { ascending: true })
        .range(offset, offset + 999);
      if (candidateError) throw candidateError;
      for (const row of candidateRows ?? []) {
        const name = cleanString(row.name);
        if (name) seenNames.add(name);
      }
      if (!candidateRows || candidateRows.length < 1000) break;
    }

    return jsonResponse({
      job_id: jobId,
      stage: "candidate_analysis",
      pages_claimed: pages?.length ?? 0,
      pages_completed: pagesCompleted,
      unique_facility_names: seenNames.size,
      remaining_pages: count ?? 0,
      has_more_work: (count ?? 0) > 0,
    });
  } catch (error) {
    console.error("施設情報分析Workerエラー:", error);
    return jsonResponse({
      error: "施設情報分析Workerでエラーが発生しました。",
      detail: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
