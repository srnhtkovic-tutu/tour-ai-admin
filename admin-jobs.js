const jobRegionId = new URLSearchParams(window.location.search).get("region");
const jobMessage = document.getElementById("jobMessage");
const jobList = document.getElementById("jobList");
const createForm = document.getElementById("jobCreateForm");

let jobRegionName = "";
let jobPageReady = false;
let jobIsSystemAdmin = false;

initializeJobManagement();

async function initializeJobManagement() {
  const { data: sessionData, error: sessionError } = await adminSupabase.auth.getSession();
  if (sessionError || !sessionData.session) {
    window.location.replace("admin-login.html");
    return;
  }

  if (!jobRegionId) {
    jobMessage.textContent = "地域が指定されていません。地域選択画面から開いてください。";
    return;
  }

  const user = sessionData.session.user;
  const { data: profile, error: profileError } = await adminSupabase
    .from("user_profiles")
    .select("is_active,is_system_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile || !profile.is_active) {
    jobMessage.textContent = "このアカウントでは業務画面を利用できません。";
    return;
  }
  jobIsSystemAdmin = Boolean(profile.is_system_admin);

  const { data: region, error: regionError } = await adminSupabase
    .from("regions")
    .select("id,name,is_active")
    .eq("id", jobRegionId)
    .maybeSingle();

  if (regionError || !region || !region.is_active) {
    jobMessage.textContent = "地域を確認できません。地域選択画面から選び直してください。";
    return;
  }

  if (!profile.is_system_admin) {
    const { data: assignment, error: assignmentError } = await adminSupabase
      .from("user_regions")
      .select("region_id")
      .eq("user_id", user.id)
      .eq("region_id", jobRegionId)
      .maybeSingle();

    if (assignmentError || !assignment) {
      jobMessage.textContent = "この地域を利用する権限がありません。";
      return;
    }
  }

  jobRegionName = region.name;
  document.getElementById("regionNameHeader").textContent = region.name;
  document.getElementById("backToSpotsLink").href =
    "admin-spots.html?region=" + encodeURIComponent(jobRegionId);

  createForm.addEventListener("submit", createJob);
  document.getElementById("refreshJobsButton").addEventListener("click", loadJobs);
  jobPageReady = true;
  jobMessage.textContent = region.name + " の収集ジョブを管理します。";
  await loadJobs();
}

async function loadJobs() {
  if (!jobPageReady) return;
  jobList.replaceChildren();
  jobMessage.textContent = "ジョブ一覧を読み込んでいます...";

  const { data, error } = await adminSupabase.rpc("list_spot_import_jobs", {
    p_region_id: jobRegionId
  });

  if (error) {
    jobMessage.textContent = explainJobError(error);
    jobList.append(makeText("p", "ジョブ一覧を読み込めませんでした。", "empty-state"));
    console.error("list_spot_import_jobs:", error);
    return;
  }

  const jobs = Array.isArray(data) ? data : [];
  jobMessage.textContent = jobRegionName + " ・ " + jobs.length + "件（最新50件）";

  if (jobIsSystemAdmin) {
    const { data: anomalyLock, error: anomalyError } = await adminSupabase.rpc(
      "get_spot_import_anomaly_lock"
    );
    if (anomalyError) {
      console.error("get_spot_import_anomaly_lock:", anomalyError);
      jobList.append(makeText(
        "p",
        "システム異常ロックの状態を確認できませんでした。管理者権限と接続状態を確認してください。",
        "job-error"
      ));
    } else if (anomalyLock?.lock_status === "anomaly") {
      jobList.append(renderAnomalyLock(anomalyLock));
    }
  }

  if (jobs.length === 0) {
    jobList.append(makeText("p", "この地域に収集ジョブはありません。", "empty-state"));
    return;
  }

  jobs.forEach(job => jobList.append(renderJob(job)));
  if (jobIsSystemAdmin) await loadFacilityErrors(jobs);
}

async function loadFacilityErrors(jobs) {
  const redesignJobIds = jobs
    .filter(job => job.pipeline_version === "redesign_v1")
    .map(job => job.id);
  if (!redesignJobIds.length) return;

  const { data, error } = await adminSupabase
    .from("spot_import_merged_v2")
    .select("id,job_id,spot_name,status,relevance_status,relevance_progress,error_message")
    .in("job_id", redesignJobIds)
    .or(
      "status.eq.failed,relevance_status.eq.failed,relevance_progress->>skip_reason.eq.edge_function_timeout,relevance_progress->>skip_reason.eq.information_merge_timeout"
    )
    .order("created_at", { ascending: true });

  if (error) {
    console.error("loadFacilityErrors:", error);
    jobList.append(makeText(
      "p",
      "施設単位のエラー一覧を読み込めませんでした。",
      "job-error"
    ));
    return;
  }

  if (!Array.isArray(data) || data.length === 0) return;

  const jobsById = new Map(jobs.map(job => [job.id, job]));
  const retryableCandidates = data.filter(candidate => {
    const parentJob = jobsById.get(candidate.job_id);
    if (parentJob?.status !== "completed" || parentJob?.final_outcome !== "partial_error") {
      return false;
    }
    const progress = candidate.relevance_progress || {};
    const isTimeoutSkipped =
      candidate.status === "skipped" &&
      candidate.relevance_status === "skipped" &&
      ["edge_function_timeout", "information_merge_timeout"].includes(progress.skip_reason);
    const isFailed =
      candidate.status === "failed" ||
      candidate.relevance_status === "failed" ||
      progress.status === "failed" ||
      progress.merge_status === "failed";
    return isTimeoutSkipped || isFailed;
  });
  if (retryableCandidates.length === 0) return;

  const panel = document.createElement("section");
  panel.className = "panel";
  panel.append(makeText("h2", "施設単位のエラー・タイムアウト（システム管理者専用）"));
  panel.append(makeText(
    "p",
    "ジョブ終了後、処理できなかった施設だけを最初から再実行できます。正常に完了したほかの施設は再処理しません。",
    "help-text"
  ));

  retryableCandidates.forEach(candidate => {
    const card = document.createElement("article");
    card.className = "job-card";
    const progress = candidate.relevance_progress || {};
    const isTimeoutSkipped =
      candidate.status === "skipped" &&
      candidate.relevance_status === "skipped" &&
      ["edge_function_timeout", "information_merge_timeout"].includes(progress.skip_reason);
    const retryKind = isTimeoutSkipped
      ? "タイムアウトでスキップ"
      : candidate.relevance_status === "failed" || progress.status === "failed"
        ? "ABCD評価の失敗"
        : "情報統合の失敗";
    const errorText = isTimeoutSkipped
      ? (progress.reason || candidate.error_message || "タイムアウトが発生しました。")
      : (progress.last_error || progress.merge_error || candidate.error_message || "詳細なエラー情報はありません。");

    card.append(makeText("strong", candidate.spot_name));
    card.append(makeText("p", "状態：" + retryKind));
    card.append(makeText("p", "理由：" + String(errorText).slice(0, 500), "job-error"));

    const actions = document.createElement("div");
    actions.className = "job-actions";
    const retryButton = makeActionButton("この施設を再実行", async () => {
      if (!window.confirm(
        "「" + candidate.spot_name + "」の情報統合を最初から再実行しますか？\n" +
        "この施設だけを再処理し、ほかの完了済み施設は変更しません。"
      )) return;
      retryButton.disabled = true;
      const { data: result, error: retryError } = await adminSupabase.rpc(
        "admin_retry_spot_import_facility",
        { p_candidate_id: candidate.id }
      );
      retryButton.disabled = false;
      if (retryError) {
        jobMessage.textContent = explainJobError(retryError);
        return;
      }
      jobMessage.textContent = "「" + candidate.spot_name + "」の再実行を登録しました。";
      console.info("admin_retry_spot_import_facility:", result);
      await loadJobs();
    });
    actions.append(retryButton);
    card.append(actions);
    panel.append(card);
  });

  jobList.append(panel);
}

function renderJob(job) {
  const card = document.createElement("article");
  card.className = "job-card";

  const heading = document.createElement("div");
  heading.className = "job-card-heading";
  const title = makeText("strong", job.source_url || "URL未設定");
  const status = makeText("span", statusLabel(job.status), "job-status");
  heading.append(title, status);

  const details = document.createElement("div");
  details.className = "job-meta";
  details.append(
    makeText("span", "工程：" + stageLabel(job.current_stage)),
    makeText("span", "施設上限：" + job.max_facilities),
    makeText("span", "バッチ：" + job.batch_size),
    makeText("span", "登録：" + formatDate(job.created_at)),
    makeText("span", "更新：" + formatDate(job.updated_at))
  );

  if (job.requested_action) {
    details.append(makeText("span", "要求中：" + actionLabel(job.requested_action)));
  }
  if (job.final_outcome) {
    details.append(makeText("span", "最終結果：" + finalOutcomeLabel(job.final_outcome)));
  }
  card.append(heading, details);

  if (job.last_error) {
    const error = makeText("p", "エラー：" + job.last_error, "job-error");
    card.append(error);
  }

  const actions = document.createElement("div");
  actions.className = "job-actions";

  if (job.status === "pending" || job.status === "running") {
    actions.append(makeActionButton("一時停止", () => requestJobAction(job, "pause")));
    actions.append(makeActionButton("キャンセル", () => requestJobAction(job, "cancel"), "secondary-button"));
  } else if (job.status === "paused") {
    actions.append(makeActionButton("再開", () => requestJobAction(job, "resume")));
    actions.append(makeActionButton("キャンセル", () => requestJobAction(job, "cancel"), "secondary-button"));
  }

  if (actions.childElementCount) card.append(actions);
  return card;
}

function renderAnomalyLock(lock) {
  const panel = document.createElement("section");
  panel.className = "job-anomaly";

  const lockedJob = lock.job || {};
  panel.append(makeText("strong", "システム異常ロックが発生しています"));
  panel.append(makeText(
    "p",
    "対象URL：" + (lockedJob.source_url || "取得できません（ジョブID：" + lock.locked_job_id + "）")
  ));
  panel.append(makeText("p", "異常理由：" + (lock.anomaly_reason || "不明")));
  panel.append(makeText(
    "p",
    "対象ジョブ状態：" + statusLabel(lockedJob.status) +
    " ・ 工程：" + stageLabel(lockedJob.current_stage)
  ));
  panel.append(makeText(
    "p",
    "ロック取得：" + formatDate(lock.lock_acquired_at) +
    " ・ 最終Heartbeat：" + formatDate(lock.last_heartbeat_at) +
    " ・ lease期限：" + formatDate(lock.lock_expires_at)
  ));
  panel.append(makeText("small", "対象ジョブID：" + (lock.locked_job_id || "不明")));

  let releaseButton;
  releaseButton = makeActionButton(
    "異常ロックを解除",
    () => releaseAnomalyLock(lock, releaseButton),
    "secondary-button"
  );
  panel.append(releaseButton);
  return panel;
}

async function releaseAnomalyLock(lock, button) {
  if (!jobIsSystemAdmin || !lock?.locked_job_id) return;

  const confirmed = window.confirm(
    "異常ロックを解除します。\n\n" +
    "実行前に、古いWorkerが停止していることをログ等で確認してください。\n" +
    "解除後、対象ジョブは一時停止状態になります。\n" +
    "ジョブの再開は別操作です。取得済みデータはリセットされません。\n\n" +
    "古いWorkerが停止していることを確認しましたか？"
  );
  if (!confirmed) return;

  const reason = window.prompt("異常ロックを解除する理由を入力してください（必須）。", "");
  if (reason === null) return;
  if (!reason.trim()) {
    window.alert("解除理由を入力してください。");
    return;
  }

  button.disabled = true;
  const { data: latestLock, error: latestError } = await adminSupabase.rpc(
    "get_spot_import_anomaly_lock"
  );
  if (latestError) {
    button.disabled = false;
    jobMessage.textContent = explainJobError(latestError);
    console.error("get_spot_import_anomaly_lock before release:", latestError);
    return;
  }

  if (
    latestLock?.lock_status !== "anomaly" ||
    latestLock?.locked_job_id !== lock.locked_job_id
  ) {
    jobMessage.textContent = "異常ロックの状態が変わっています。一覧を更新しました。";
    await loadJobs();
    return;
  }

  const { data: result, error } = await adminSupabase.rpc(
    "release_spot_import_anomaly_lock",
    {
      p_confirm_old_worker_stopped: true,
      p_reason: reason.trim()
    }
  );

  if (error) {
    button.disabled = false;
    jobMessage.textContent = explainJobError(error);
    console.error("release_spot_import_anomaly_lock:", error);
    return;
  }

  if (
    result?.released !== true ||
    result?.job_id !== lock.locked_job_id ||
    result?.processing_data_reset !== false
  ) {
    button.disabled = false;
    jobMessage.textContent = "解除結果を想定どおり確認できませんでした。状態を再確認してください。";
    console.error("Unexpected anomaly lock release result:", result);
    await loadJobs();
    return;
  }

  await loadJobs();
  jobMessage.textContent =
    "異常ロックを解除しました。対象ジョブは一時停止状態です。データはリセットしていません。ジョブの再開はまだ行っていません。";
}

async function createJob(event) {
  event.preventDefault();
  const errorBox = document.getElementById("createJobError");
  const button = document.getElementById("createJobButton");
  errorBox.textContent = "";

  const sourceUrl = document.getElementById("sourceUrl").value.trim();
  const maxFacilities = Number(document.getElementById("maxFacilities").value);
  const batchSize = Number(document.getElementById("batchSize").value);

  let parsedUrl;
  try { parsedUrl = new URL(sourceUrl); } catch {
    errorBox.textContent = "URLの形式を確認してください。";
    return;
  }
  if (parsedUrl.protocol !== "https:") {
    errorBox.textContent = "収集元URLにはHTTPSを指定してください。";
    return;
  }
  if (!Number.isInteger(maxFacilities) || maxFacilities < 1 || maxFacilities > 10000) {
    errorBox.textContent = "最大施設数は1〜10000の整数で入力してください。";
    return;
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    errorBox.textContent = "バッチサイズは1〜1000の整数で入力してください。";
    return;
  }

  const confirmed = window.confirm(
    "次の内容で収集ジョブを登録します。\n\n" +
    "地域：" + jobRegionName + "\n" +
    "開始URL：" + sourceUrl + "\n" +
    "最大施設数：" + maxFacilities + "\n" +
    "バッチサイズ：" + batchSize + "\n\n" +
    "登録すると開始指示付きで待機列に入り、自動処理が始まります。よろしいですか？"
  );
  if (!confirmed) return;

  button.disabled = true;
  button.textContent = "登録しています...";
  const { data, error } = await adminSupabase.rpc("create_spot_import_job", {
    p_region_id: jobRegionId,
    p_source_url: sourceUrl,
    p_max_facilities: maxFacilities,
    p_batch_size: batchSize
  });
  button.disabled = false;
  button.textContent = "収集ジョブを登録";

  if (error) {
    errorBox.textContent = explainJobError(error);
    console.error("create_spot_import_job:", error);
    return;
  }

  createForm.reset();
  document.getElementById("maxFacilities").value = "1";
  document.getElementById("batchSize").value = "10";
  jobMessage.textContent = "ジョブを登録しました。処理待ち列に入りました。";
  await loadJobs();
}

async function requestJobAction(job, action) {
  const prompts = {
    pause: "このジョブに一時停止を要求しますか？実行中の処理単位は完了してから停止します。",
    resume: "このジョブを再開しますか？",
    cancel: "このジョブをキャンセルしますか？実行中の場合は処理単位の完了後に反映されます。"
  };
  if (!window.confirm("「" + job.source_url + "」\n" + prompts[action])) return;

  const { error } = await adminSupabase.rpc("request_spot_import_job_action", {
    p_job_id: job.id,
    p_action: action
  });
  if (error) {
    jobMessage.textContent = explainJobError(error);
    console.error("request_spot_import_job_action:", error);
    return;
  }
  jobMessage.textContent = "操作要求を記録しました。";
  await loadJobs();
}

function makeActionButton(label, onClick, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", onClick);
  return button;
}

function makeText(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text ?? "";
  if (className) element.className = className;
  return element;
}

function statusLabel(status) {
  const labels = {
    pending: "待機中", running: "実行中", paused: "一時停止",
    completed: "処理完了・人の審査待ち", cancelled: "キャンセル",
    failed: "失敗", error: "エラー"
  };
  return labels[status] || status || "状態不明";
}

function finalOutcomeLabel(outcome) {
  const labels = {
    normal_completed: "正常完了",
    partial_error: "一部エラーあり",
    cancelled: "キャンセル"
  };
  return labels[outcome] || outcome || "未設定";
}

function stageLabel(stage) {
  const labels = {
    url_collection: "URL収集",
    page_extraction: "施設名抽出",
    candidate_analysis: "旧候補詳細分析",
    information_merge: "ABCD評価・情報統合",
    human_review: "人による審査",
    extraction: "情報抽出",
    analysis: "分析",
    ai_merge: "AI統合"
  };
  return labels[stage] || stage || "未設定";
}

function actionLabel(action) {
  const labels = { start: "開始", pause: "一時停止", resume: "再開", cancel: "キャンセル" };
  return labels[action] || action;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ja-JP");
}

function explainJobError(error) {
  const message = String(error?.message || "");
  if (message.includes("source_domain_not_allowed")) return "このURLのドメインは、選択中の地域の許可ドメインに登録されていません。";
  if (message.includes("invalid_source_url_https_required")) return "HTTPSのURLを指定してください。";
  if (message.includes("region_access_denied")) return "この地域を利用する権限がありません。";
  if (message.includes("region_not_active")) return "この地域は無効になっています。";
  if (message.includes("job_cannot_be_paused")) return "この状態のジョブは一時停止できません。";
  if (message.includes("job_cannot_be_resumed")) return "この状態のジョブは再開できません。";
  if (message.includes("job_cannot_be_cancelled")) return "この状態のジョブはキャンセルできません。";
  return message || "処理に失敗しました。時間をおいて再度お試しください。";
}
