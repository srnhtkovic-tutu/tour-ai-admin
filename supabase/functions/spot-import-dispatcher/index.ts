import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const cronSecret = Deno.env.get("TABITSUZUKI_CRON_SECRET") ?? "";
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
function safeLogText(value: unknown): string {
  let message = "";
  if (value instanceof Error) message = value.message;
  else if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    const parts = [
      fields.message,
      fields.code !== undefined ? `code=${String(fields.code)}` : null,
      fields.details !== undefined ? `details=${String(fields.details)}` : null,
      fields.hint !== undefined ? `hint=${String(fields.hint)}` : null,
      fields.status !== undefined ? `status=${String(fields.status)}` : null,
    ].filter((part) => part !== null && part !== undefined && String(part).length > 0);
    if (parts.length) message = parts.join(" | ");
    else { try { message = JSON.stringify(value) ?? Object.prototype.toString.call(value); } catch { message = Object.prototype.toString.call(value); } }
  } else message = String(value ?? "");
  for (const secret of [serviceRoleKey, cronSecret]) if (secret) message = message.split(secret).join("[REDACTED]");
  return message.replace(/(key=)[^&\\s]+/gi, "$1[REDACTED]").replace(/Bearer\\s+[^\\s]+/gi, "Bearer [REDACTED]").slice(0, 1200);
}
function logEvent(event: string, fields: Record<string, unknown> = {}) {
  try {
    console.log(JSON.stringify({ component: "dispatcher", event, timestamp: new Date().toISOString(), ...fields }));
  } catch { /* ログ失敗で本来の処理を止めない */ }
}
function safeErrorFields(error: unknown) {
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const cause = fields.cause && typeof fields.cause === "object" ? fields.cause as Record<string, unknown> : {};
  const getField = (key: string) => {
    const value = fields[key] ?? cause[key];
    return value === undefined || value === null ? null : safeLogText(value);
  };
  return {
    error_name: error instanceof Error ? error.name : safeLogText(fields.name ?? "UnknownError"),
    error_message: safeLogText(error),
    error_code: getField("code"),
    error_details: getField("details"),
    error_hint: getField("hint"),
    error_status: getField("status"),
    error_context: getField("context"),
    error_cause: fields.cause === undefined ? null : safeLogText(fields.cause),
    error_stack: error instanceof Error && error.stack ? safeLogText(error.stack).slice(0, 3000) : null,
  };
}

type MergeTask = { spot_name: string; mode: "process" | "start" | "continue" | "merge" } | null;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function callRpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}

async function markMergeTimeoutSkipped(
  jobId: string,
  spotName: string,
  detail: string,
  timeoutType: "edge_function" | "gemini_signal",
) {
  const now = new Date().toISOString();
  const reason = timeoutType === "gemini_signal"
    ? "Geminiへのリクエストが規定時間内に完了しなかったため、この施設をスキップしました。"
    : "情報統合WorkerのEdge Function実行時間上限に達したため、この施設をスキップしました。";
  const { data: existing, error: findError } = await supabase
    .from("spot_import_merged_v2")
    .select("id,relevance_progress")
    .eq("job_id", jobId)
    .eq("spot_name", spotName)
    .maybeSingle();
  if (findError) throw findError;

  const progress = {
    ...(existing?.relevance_progress && typeof existing.relevance_progress === "object"
      ? existing.relevance_progress
      : {}),
    job_id: jobId,
    spot_name: spotName,
    status: "skipped",
    skip_reason: "information_merge_timeout",
    timeout_type: timeoutType,
    reason,
    timeout_detail: detail.slice(0, 1000),
    skipped_at: now,
  };
  const values = {
    status: "skipped",
    relevance_status: "skipped",
    error_message: reason,
    relevance_progress: progress,
    updated_at: now,
  };

  if (existing) {
    const { error } = await supabase
      .from("spot_import_merged_v2")
      .update(values)
      .eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("spot_import_merged_v2")
      .insert({ job_id: jobId, spot_name: spotName, ...values });
    if (error) throw error;
  }
}

async function getNextMergeTask(jobId: string): Promise<MergeTask> {
  // 施設名はページ抽出結果の保存順で取得し、文字列完全一致だけで重複を除外する。
  const candidateRows: any[] = [];
  const candidatePageSize = 1000;
  for (let offset = 0; ; offset += candidatePageSize) {
    const { data, error } = await supabase
      .from("spot_import_candidates")
      .select("name")
      .eq("job_id", jobId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + candidatePageSize - 1);
    if (error) throw error;
    candidateRows.push(...(data ?? []));
    if (!data || data.length < candidatePageSize) break;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of candidateRows) {
    const name = String(row.name ?? "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  const mergedRows: any[] = [];
  const mergedPageSize = 1000;
  for (let offset = 0; ; offset += mergedPageSize) {
    const { data, error } = await supabase
      .from("spot_import_merged_v2")
      .select("spot_name,status,merged_data,relevance_status,relevance_results,relevance_progress")
      .eq("job_id", jobId)
      .order("created_at", { ascending: true })
      .range(offset, offset + mergedPageSize - 1);
    if (error) throw error;
    mergedRows.push(...(data ?? []));
    if (!data || data.length < mergedPageSize) break;
  }

  // spot_import_merged_v2には(job_id, spot_name)の一意制約がある。
  // 表記揺れをまとめず、施設名の文字列をそのままキーにする。
  const mergedByName = new Map<string, any>();
  for (const row of mergedRows) mergedByName.set(String(row.spot_name ?? ""), row);

  for (const spotName of names) {
    const row = mergedByName.get(spotName);
    if (row?.status === "skipped" || row?.relevance_status === "skipped") continue;

    if (!row) return { spot_name: spotName, mode: "process" };

    // 完了・スキップ済みだけを通過する。失敗や途中状態は自動再開せず異常停止する。
    if (row.status === "failed" || row.relevance_status === "failed") {
      throw new Error(`スポット「${spotName}」の情報統合が失敗状態です。管理者による確認が必要です。`);
    }
    if (row.merged_data && row.relevance_progress?.merged_at) continue;

    throw new Error(`スポット「${spotName}」に未完了の統合データが残っています。自動再開は行いません。`);
  }

  return null;
}

function normalizeNameLegacy(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

async function getNextMergeTaskLegacy(jobId: string): Promise<MergeTask> {
  const candidateRows: any[] = [];
  const candidatePageSize = 1000;
  for (let offset = 0; ; offset += candidatePageSize) {
    const { data, error } = await supabase
      .from("spot_import_candidates")
      .select("name")
      .eq("job_id", jobId)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + candidatePageSize - 1);
    if (error) throw error;
    candidateRows.push(...(data ?? []));
    if (!data || data.length < candidatePageSize) break;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of candidateRows) {
    const name = String(row.name ?? "").trim();
    const key = normalizeNameLegacy(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  // job_idでページ候補を一括ページングし、施設名との照合はメモリ上で行う。
  // 施設名100件ずつの.in()検索を繰り返す方式を避け、DBアクセス回数を抑える。
  const pageCandidateNames = new Set<string>();
  const pageCandidatePageSize = 1000;
  for (let offset = 0; ; offset += pageCandidatePageSize) {
    const { data, error } = await supabase
      .from("spot_import_page_candidates")
      .select("name")
      .eq("job_id", jobId)
      .order("id", { ascending: true })
      .range(offset, offset + pageCandidatePageSize - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      const name = String(row.name ?? "");
      if (name) pageCandidateNames.add(name);
    }
    if (!data || data.length < pageCandidatePageSize) break;
  }

  const mergedRows: any[] = [];
  const mergedPageSize = 1000;
  for (let offset = 0; ; offset += mergedPageSize) {
    const { data, error } = await supabase
      .from("spot_import_merged_v2")
      .select("spot_name,status,merged_data,relevance_status,relevance_progress")
      .eq("job_id", jobId)
      .order("spot_name", { ascending: true })
      .range(offset, offset + mergedPageSize - 1);
    if (error) throw error;
    mergedRows.push(...(data ?? []));
    if (!data || data.length < mergedPageSize) break;
  }

  const mergedByName = new Map<string, any>();
  for (const row of mergedRows) mergedByName.set(normalizeNameLegacy(row.spot_name), row);

  for (const spotName of names) {
    const row = mergedByName.get(normalizeNameLegacy(spotName));
    if (row?.status === "skipped" || row?.relevance_status === "skipped") continue;

    if (!pageCandidateNames.has(spotName) && !row) {
      const skippedAt = new Date().toISOString();
      const skipReason = "ページ候補テーブルに完全一致する候補名がないため、今回の統合対象からスキップしました。";
      const { error: skipError } = await supabase
        .from("spot_import_merged_v2")
        .insert({
          job_id: jobId,
          spot_name: spotName,
          status: "skipped",
          error_message: skipReason,
          relevance_status: "skipped",
          relevance_progress: {
            job_id: jobId,
            spot_name: spotName,
            status: "skipped",
            skip_reason: "no_exact_page_candidate",
            reason: skipReason,
            skipped_at: skippedAt,
          },
        });
      if (skipError) throw skipError;
      logEvent("dispatcher.merge_candidate_skipped", {
        job_id: jobId,
        spot_name: spotName,
        reason: "no_exact_page_candidate",
        skipped_at: skippedAt,
      });
      continue;
    }

    if (!row) return { spot_name: spotName, mode: "start" };

    if (row.status === "failed" || row.relevance_status === "failed") {
      throw new Error(`スポット「${spotName}」の統合処理が失敗状態です。管理者による確認が必要です。`);
    }

    if (row.merged_data && row.relevance_progress?.merged_at) continue;

    if (row.relevance_status === "completed") {
      return { spot_name: spotName, mode: "merge" };
    }

    if (row.relevance_progress?.sources && Array.isArray(row.relevance_progress.sources)) {
      return { spot_name: spotName, mode: "continue" };
    }

    if (!row.relevance_progress && (!row.relevance_results || row.relevance_results.length === 0)) {
      return { spot_name: spotName, mode: "start" };
    }

    throw new Error(`スポット「${spotName}」の統合進捗データを確認できません。管理者による確認が必要です。`);
  }

  return null;
}

async function markAnomaly(claim: any, reason: string) {
  if (!claim?.job_id || !claim?.execution_id || !claim?.lock_token) return;
  try {
    await callRpc("mark_spot_import_execution_anomaly", {
      p_job_id: claim.job_id,
      p_execution_id: claim.execution_id,
      p_lock_token: claim.lock_token,
      p_reason: reason.slice(0, 900),
    });
  } catch (error) {
    console.error("異常停止の記録にも失敗:", String(error));
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POSTで実行してください。" }, 405);
  if (!supabaseUrl || !serviceRoleKey || !cronSecret) return jsonResponse({ error: "サーバー設定が不足しています。" }, 500);

  if (
    req.headers.get("authorization") !== `Bearer ${cronSecret}` ||
    req.headers.get("apikey") !== cronSecret
  ) return jsonResponse({ error: "認証に失敗しました。" }, 401);

  const invocationId = crypto.randomUUID();
  const invocationStarted = performance.now();
  let logJobId: string | null = null;
  let logExecutionId: string | null = null;
  let logStage: string | null = null;
  logEvent("dispatcher.started", { invocation_id: invocationId });
  let claim: any = null;
  let heartbeatTimer: number | undefined;
  let heartbeatInFlight = false;
  let heartbeatError: string | null = null;

  try {
    const body = await req.json().catch(() => ({}));
    const leaseSeconds = Number(body.lease_seconds);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
      return jsonResponse({
        error: "lease_secondsには正の整数を指定してください。実行リース時間は運用設定として明示する必要があります。",
      }, 400);
    }

    const claimStarted = performance.now();
    logEvent("dispatcher.claim_started", { invocation_id: invocationId, lease_seconds: leaseSeconds });
    claim = await callRpc("claim_spot_import_execution", {
      p_lease_seconds: leaseSeconds,
    });
    logEvent("dispatcher.claim_completed", {
      invocation_id: invocationId, duration_ms: Math.round(performance.now() - claimStarted),
      claim_status: claim?.status ?? (claim ? "claimed" : "idle"),
      job_id: claim?.job_id ?? null, execution_id: claim?.execution_id ?? null, stage: claim?.stage ?? null,
    });

    if (!claim) {
      logEvent("dispatcher.idle", { invocation_id: invocationId, duration_ms: Math.round(performance.now() - invocationStarted) });
      return jsonResponse({ status: "idle", message: "実行対象のジョブはありません。" });
    }
    if (claim.status === "anomaly") {
      logEvent("dispatcher.anomaly_claim", { invocation_id: invocationId, duration_ms: Math.round(performance.now() - invocationStarted) });
      return jsonResponse({ status: "anomaly", message: "実行リース期限切れを検出しました。管理者の確認が必要です。" }, 409);
    }

    const stage = String(claim.stage ?? "");
    const jobId = String(claim.job_id ?? "");
    const executionId = String(claim.execution_id ?? "");
    const lockToken = String(claim.lock_token ?? "");
    // 既存ジョブはlegacy_v1、新規ジョブはredesign_v1として別経路で処理する。
    const pipelineVersion = String(claim.pipeline_version ?? "legacy_v1");
    logJobId = jobId;
    logExecutionId = executionId;
    logStage = stage;
    if (!jobId || !executionId || !lockToken) throw new Error("実行権情報が不足しています。");

    const workerByStage: Record<string, string> = {
      url_collection: "collect-spot-import-urls-worker-v2",
      page_extraction: "extract-spot-page-candidates-worker-v2",
      candidate_analysis: "analyze-spot-import-batch-worker-v2",
      information_merge: pipelineVersion === "redesign_v1"
        ? "merge-spot-information-v3-worker"
        : "merge-spot-information-v2-worker",
    };
    const workerSlug = workerByStage[stage];
    if (!workerSlug) throw new Error(`未対応の処理工程です: ${stage}`);

    const heartbeat = async () => {
      if (heartbeatInFlight || heartbeatError) return;
      heartbeatInFlight = true;
      const heartbeatStarted = performance.now();
      logEvent("dispatcher.heartbeat_started", { invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage });
      try {
        await callRpc("heartbeat_spot_import_execution", {
          p_job_id: jobId,
          p_execution_id: executionId,
          p_lock_token: lockToken,
          p_lease_seconds: leaseSeconds,
        });
        logEvent("dispatcher.heartbeat_succeeded", {
          invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
          duration_ms: Math.round(performance.now() - heartbeatStarted),
        });
      } catch (error) {
        heartbeatError = safeLogText(error);
        logEvent("dispatcher.heartbeat_failed", {
          invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
          duration_ms: Math.round(performance.now() - heartbeatStarted), ...safeErrorFields(error),
        });
        console.error("Heartbeat失敗:", heartbeatError);
      } finally {
        heartbeatInFlight = false;
      }
    };

    // Workerの実行中もリースを延長する。間隔は指定されたリース時間から算出する。
    const heartbeatIntervalMs = Math.max(1000, Math.floor(leaseSeconds * 1000 / 3));
    heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatIntervalMs) as unknown as number;
    await heartbeat();

    let workerMode: string | null = null;
    let workerSpotName: string | null = null;
    let hasMoreWork = false;
    let workerResult: any = null;

    if (stage === "information_merge") {
      let task: MergeTask;
      try {
        task = pipelineVersion === "redesign_v1"
          ? await getNextMergeTask(jobId)
          : await getNextMergeTaskLegacy(jobId);
      } catch (error) {
        const wrapped = new Error(`情報統合タスク選択中に失敗: ${safeLogText(error)}`);
        (wrapped as Error & { cause?: unknown; context?: string }).cause = error;
        (wrapped as Error & { cause?: unknown; context?: string }).context = "getNextMergeTask";
        throw wrapped;
      }
      if (!task) {
        hasMoreWork = false;
        workerResult = { message: "統合対象のスポットはすべて処理済みです。" };
      } else {
        workerMode = task.mode;
        workerSpotName = task.spot_name;
        const workerStarted = performance.now();
        logEvent("dispatcher.worker_call_started", {
          invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
          worker: workerSlug, worker_mode: task.mode,
        });
        let response: Response;
        try {
          response = await fetch(`${supabaseUrl}/functions/v1/${workerSlug}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${serviceRoleKey}`,
              "apikey": serviceRoleKey,
              "x-tabitsuzuki-dispatch-invocation-id": invocationId,
            },
            body: JSON.stringify({
              job_id: jobId, execution_id: executionId, lock_token: lockToken,
              mode: task.mode, spot_name: task.spot_name,
            }),
          });
        } catch (error) {
          logEvent("dispatcher.worker_call_failed", {
            invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
            worker: workerSlug, duration_ms: Math.round(performance.now() - workerStarted), ...safeErrorFields(error),
          });
          throw error;
        }
        const raw = await response.text();
        logEvent("dispatcher.worker_response_received", {
          invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
          worker: workerSlug, http_status: response.status, response_bytes: raw.length,
          duration_ms: Math.round(performance.now() - workerStarted),
        });
        try { workerResult = JSON.parse(raw); } catch {
          logEvent("dispatcher.worker_response_parse_failed", {
            invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
            worker: workerSlug, http_status: response.status, response_bytes: raw.length,
          });
          workerResult = { raw_response: raw.slice(0, 1000) };
        }
        const edgeFunctionTimedOut =
          (response.status === 504 && /Request idle timeout limit/i.test(raw)) ||
          (response.status === 546 && /wall clock time limit reached/i.test(raw));
        // WorkerがGeminiのAbortSignal.timeoutで返す、既知のタイムアウトだけを追加対象にする。
        // HTTP 500のほかのエラーは従来どおり異常停止させる。
        const geminiSignalTimedOut =
          response.status === 500 && workerResult?.error === "Signal timed out.";
        const timeoutType = edgeFunctionTimedOut
          ? "edge_function"
          : geminiSignalTimedOut
            ? "gemini_signal"
            : null;

        if (timeoutType && pipelineVersion === "redesign_v1") {
          // 既知のEdge Function実行時間上限、またはGeminiの既知のSignal timeoutだけを施設単位でスキップする。
          // CPU/メモリ等の546、fetch例外、その他HTTPエラーは通常の異常停止とする。
          await markMergeTimeoutSkipped(jobId, task.spot_name, raw, timeoutType);
          logEvent("dispatcher.merge_facility_skipped_timeout", {
            invocation_id: invocationId,
            job_id: jobId,
            execution_id: executionId,
            spot_name: task.spot_name,
            http_status: response.status,
            timeout_type: timeoutType,
          });
          workerResult = {
            success: true,
            facility_status: "skipped",
            reason: "information_merge_timeout",
            timeout_type: timeoutType,
          };
        } else if (!response.ok || workerResult?.success === false || workerResult?.error) {
          throw new Error(`統合Workerエラー: ${JSON.stringify(workerResult).slice(0, 1200)}`);
        }

        let nextTask: MergeTask;
        try {
          nextTask = pipelineVersion === "redesign_v1"
            ? await getNextMergeTask(jobId)
            : await getNextMergeTaskLegacy(jobId);
        } catch (error) {
          const wrapped = new Error(`統合Worker完了後の次タスク確認中に失敗: ${safeLogText(error)}`);
          (wrapped as Error & { cause?: unknown; context?: string }).cause = error;
          (wrapped as Error & { cause?: unknown; context?: string }).context = "getNextMergeTask_after_worker";
          throw wrapped;
        }
        hasMoreWork = nextTask !== null;
      }
    } else {
      const workerStarted = performance.now();
      logEvent("dispatcher.worker_call_started", {
        invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage, worker: workerSlug,
      });
      let response: Response;
      try {
        response = await fetch(`${supabaseUrl}/functions/v1/${workerSlug}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceRoleKey}`,
            "apikey": serviceRoleKey,
            "x-tabitsuzuki-dispatch-invocation-id": invocationId,
          },
          body: JSON.stringify({ job_id: jobId, execution_id: executionId, lock_token: lockToken }),
        });
      } catch (error) {
        logEvent("dispatcher.worker_call_failed", {
          invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
          worker: workerSlug, duration_ms: Math.round(performance.now() - workerStarted), ...safeErrorFields(error),
        });
        throw error;
      }
      const raw = await response.text();
      logEvent("dispatcher.worker_response_received", {
        invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
        worker: workerSlug, http_status: response.status, response_bytes: raw.length,
        duration_ms: Math.round(performance.now() - workerStarted),
      });
      try { workerResult = JSON.parse(raw); } catch {
        logEvent("dispatcher.worker_response_parse_failed", {
          invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
          worker: workerSlug, http_status: response.status, response_bytes: raw.length,
        });
        workerResult = { raw_response: raw.slice(0, 1000) };
      }
      if (!response.ok || workerResult?.error) {
        throw new Error(`${stage} Workerエラー: ${JSON.stringify(workerResult).slice(0, 1200)}`);
      }
      hasMoreWork = workerResult?.has_more_work === true;
    }

    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    if (heartbeatInFlight) {
      while (heartbeatInFlight) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (heartbeatError) throw new Error(`実行リースの延長に失敗しました: ${heartbeatError}`);

    const transitions: Record<string, string | null> = pipelineVersion === "redesign_v1"
      ? {
          url_collection: "page_extraction",
          page_extraction: "candidate_analysis",
          candidate_analysis: "information_merge",
          information_merge: null,
        }
      : {
          url_collection: "page_extraction",
          page_extraction: "candidate_analysis",
          candidate_analysis: "information_merge",
          information_merge: null,
        };
    const nextStage = hasMoreWork ? stage : transitions[stage];

    const finishStarted = performance.now();
    logEvent("dispatcher.finish_started", {
      invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
      next_stage: nextStage, has_more_work: hasMoreWork,
    });
    const finishResult = await callRpc("finish_spot_import_execution", {
      p_job_id: jobId,
      p_execution_id: executionId,
      p_lock_token: lockToken,
      p_next_stage: nextStage,
    });
    logEvent("dispatcher.finish_completed", {
      invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
      duration_ms: Math.round(performance.now() - finishStarted),
      resulting_stage: finishResult?.current_stage ?? null, resulting_status: finishResult?.status ?? null,
    });
    logEvent("dispatcher.completed", {
      invocation_id: invocationId, job_id: jobId, execution_id: executionId, stage,
      duration_ms: Math.round(performance.now() - invocationStarted), has_more_work: hasMoreWork,
    });

    return jsonResponse({
      status: "processed",
      job_id: jobId,
      stage,
      worker: workerSlug,
      worker_mode: workerMode,
      spot_name: workerSpotName,
      has_more_work: hasMoreWork,
      next_stage: finishResult?.current_stage ?? null,
      job_status: finishResult?.status ?? null,
      worker_result: workerResult,
    });
  } catch (error) {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    const reason = safeLogText(error);
    logEvent("dispatcher.exception", {
      invocation_id: invocationId, job_id: logJobId, execution_id: logExecutionId, stage: logStage,
      duration_ms: Math.round(performance.now() - invocationStarted), ...safeErrorFields(error),
    });
    await markAnomaly(claim, reason);
    return jsonResponse({
      status: "anomaly",
      error: reason,
      job_id: claim?.job_id ?? null,
      stage: claim?.stage ?? null,
    }, 500);
  }
});
