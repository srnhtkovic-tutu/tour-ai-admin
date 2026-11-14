const jobRegionId = new URLSearchParams(window.location.search).get("region");
const jobMessage = document.getElementById("jobMessage");
const jobList = document.getElementById("jobList");
const createForm = document.getElementById("jobCreateForm");

let jobRegionName = "";
let jobPageReady = false;

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

  if (jobs.length === 0) {
    jobList.append(makeText("p", "この地域に収集ジョブはありません。", "empty-state"));
    return;
  }

  jobs.forEach(job => jobList.append(renderJob(job)));
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
    details.append(makeText("span", "最終結果：" + job.final_outcome));
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

function stageLabel(stage) {
  const labels = {
    url_collection: "URL収集", extraction: "情報抽出",
    analysis: "分析", ai_merge: "AI統合", human_review: "人による審査"
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
