import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "gemini-2.5-flash";
const RELEVANCE_MODEL = "gemini-2.5-flash";
const MAX_INPUT_CHARS = 80000;
const RELEVANCE_BATCH_SIZE = 25;
const TABLE_NAME = "spot_import_merged_v2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const geminiApiKey = Deno.env.get("GEMINI_API_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

type RelevanceClass = "A" | "B" | "C" | "D" | "review_required";
type RelevanceResult = {
  page_id: string;
  page_ids: string[];
  relevance_class: RelevanceClass;
  relevance_reason: string;
  relevant_information: string;
};
type Source = {
  url: string;
  page_title: string;
  extracted_text: string;
  page_ids: string[];
  candidate_ids: string[];
  categories: string[];
  evidence_texts: string[];
  fetched_order: number;
  sent_to_gemini: boolean;
  relevance_class?: RelevanceClass;
  relevance_reason?: string;
  relevant_information?: string;
  used_for_merge: boolean;
};

type GuideData = {
  catchCopy: string;
  topReason: string;
  highlightPoints: string[];
  tags: string[];
  bestSeason: string;
  latestTopics: string;
  officialUrl: string;
  recommendFood: string;
  recommendHistory: string;
  recommendRelax: string;
  recommendActivity: string;
  localRecommendation: string;
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// URLを正規化して、同じページを識別する。
function normalizeUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.protocol = "https:";
    let pathname = parsed.pathname.replace(/\/index\.html$/i, "/");
    if (pathname !== "/") pathname = pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return `${parsed.origin}${pathname}`;
  } catch {
    return url;
  }
}

function parseGeminiJson(text: string) {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(cleaned);
}

async function callGemini(model: string, prompt: string, timeoutMs = 90000) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini APIエラー (${response.status}): ${errorText}`);
  }
  const result = await response.json();
  const generatedText = result.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || "").join("");
  if (!generatedText) throw new Error("Geminiから回答が返されませんでした。");
  return parseGeminiJson(generatedText);
}

// job_id と spot_name の両方で新版の進捗レコードを特定する。
async function getMergedRow(jobId: string, spotName: string) {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select("*")
    .eq("job_id", jobId)
    .eq("spot_name", spotName)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function saveProgress(
  jobId: string,
  spotName: string,
  relevanceStatus: string,
  results: RelevanceResult[],
  progress: any,
  executionId: string,
  lockToken: string,
  options: any = {},
) {
  const sourceCandidateIds = options.sourceCandidateIds ?? progress.candidate_ids ?? [];
  const sourceUrlIds = options.sourceUrlIds ?? [...new Set(
    (progress.sources ?? []).flatMap((source: any) => source.page_ids ?? [])
  )];

  const { data, error } = await supabase.rpc("worker_save_merge_progress", {
    p_job_id: jobId,
    p_execution_id: executionId,
    p_lock_token: lockToken,
    p_spot_name: spotName,
    p_status: options.status ?? "pending",
    p_source_count: options.sourceCount ?? 0,
    p_input_char_count: options.inputCharCount ?? 0,
    p_source_candidate_ids: sourceCandidateIds,
    p_source_url_ids: sourceUrlIds,
    p_sources: options.sources ?? progress.sources ?? [],
    p_merged_data: options.mergedData ?? null,
    p_model: options.model ?? null,
    p_relevance_status: relevanceStatus,
    p_relevance_results: results,
    p_relevance_model: RELEVANCE_MODEL,
    p_relevance_progress: progress,
  });
  if (error) throw error;
  return data;
}

async function fetchAllRows(
  buildQuery: (from: number, to: number) => any,
  pageSize = 1000,
): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await buildQuery(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function buildSources(jobId: string, spotName: string) {
  const candidates = await fetchAllRows((from, to) => supabase
    .from("spot_import_page_candidates")
    .select("id, name, source_url_id, category, evidence_text")
    .eq("name", spotName)
    .eq("job_id", jobId)
    .order("extraction_order", { ascending: true })
    .range(from, to));

  const candidateIdsByPage = new Map<string, string[]>();
  const categoriesByPage = new Map<string, string[]>();
  const evidenceByPage = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (!candidate.source_url_id) continue;
    const id = String(candidate.source_url_id);
    const ids = candidateIdsByPage.get(id) || [];
    ids.push(String(candidate.id));
    candidateIdsByPage.set(id, ids);

    const categories = categoriesByPage.get(id) || [];
    if (typeof candidate.category === "string" && candidate.category.trim()) categories.push(candidate.category.trim());
    categoriesByPage.set(id, categories);

    const evidence = evidenceByPage.get(id) || [];
    if (typeof candidate.evidence_text === "string" && candidate.evidence_text.trim()) evidence.push(candidate.evidence_text.trim());
    evidenceByPage.set(id, evidence);
  }

  const allPages = await fetchAllRows((from, to) => supabase
    .from("spot_import_urls")
    .select("id, url, page_title, extracted_text, fetched_order")
    .eq("job_id", jobId)
    .eq("crawl_status", "fetched")
    .order("fetched_order", { ascending: true })
    .range(from, to));

  // 候補が抽出されたページに加え、タイトルまたは本文に施設名が完全な文字列として
  // 含まれる収集済みページも対象にする。ILIKEのワイルドカード解釈は使わない。
  const pages = allPages.filter((page: any) => {
    const pageId = String(page.id);
    const title = typeof page.page_title === "string" ? page.page_title : "";
    const body = typeof page.extracted_text === "string" ? page.extracted_text : "";
    return candidateIdsByPage.has(pageId) || title.includes(spotName) || body.includes(spotName);
  });

  const sourceMap = new Map<string, Source>();
  for (const page of pages) {
    const pageId = String(page.id);
    const key = page.url ? normalizeUrl(page.url) : `no-url-${pageId}`;
    const pageCandidateIds = candidateIdsByPage.get(pageId) || [];
    const pageCategories = categoriesByPage.get(pageId) || [];
    const pageEvidence = evidenceByPage.get(pageId) || [];

    if (sourceMap.has(key)) {
      // URL重複時は、収集順で最初のページ本文を代表として保持する。
      const existing = sourceMap.get(key)!;
      if (!existing.page_ids.includes(pageId)) existing.page_ids.push(pageId);
      for (const id of pageCandidateIds) if (!existing.candidate_ids.includes(id)) existing.candidate_ids.push(id);
      for (const category of pageCategories) if (!existing.categories.includes(category)) existing.categories.push(category);
      for (const evidence of pageEvidence) if (!existing.evidence_texts.includes(evidence)) existing.evidence_texts.push(evidence);
      continue;
    }

    sourceMap.set(key, {
      url: page.url || "",
      page_title: page.page_title || "",
      extracted_text: page.extracted_text || "",
      page_ids: [pageId],
      candidate_ids: [...new Set(pageCandidateIds)],
      categories: [...new Set(pageCategories)],
      evidence_texts: [...new Set(pageEvidence)],
      fetched_order: Number(page.fetched_order || 0),
      sent_to_gemini: false,
      used_for_merge: false,
    });
  }

  // sourceMapはfetched_order順に追加されているため、並べ替えず収集順を維持する。
  return { candidates, pages, sources: Array.from(sourceMap.values()) };
}

function makeRelevancePrompt(spotName: string, batchItems: any[]) {
  // GeminiにはUUIDを渡さず、バッチ内だけで有効な連番を識別子として渡す。
  const promptItems = batchItems.map((item) => ({
    item_no: item.item_no,
    url: item.url,
    page_title: item.page_title,
    extracted_text: item.extracted_text,
  }));
  return `
あなたは地域観光情報を調査・整理する専門家です。
対象スポットに関係するWebページを、1ページずつ評価してください。

【対象スポット】
${spotName}

【分類基準】
A：対象スポットそのものの紹介・基本情報（所在地、利用案内、料金、アクセス等）
B：対象スポット固有の歴史・文化・特徴・体験
C：対象スポットを訪れる動機につながる地域・周辺情報、モデルコース等
D：名称が出るだけ、別施設の情報、具体的な関連情報がないページ
review_required：情報不足で判断できないページ

【重要な判断ルール】
1. 登場回数だけでAやBにしないでください。
2. 対象スポット自身の情報と、別施設・周辺地域の情報を区別してください。
3. Cは地域・周辺の補足情報であり、対象施設自身の基本情報ではありません。
4. 情報不足なら無理にDにせずreview_requiredにしてください。
5. URLやタイトルの形式だけで分類しないでください。
6. 入力されたすべてのページを1件ずつ評価してください。
7. 与えられた情報から判断できない事実を推測しないでください。
8. item_noは入力された整数をそのまま返してください。変更・採番し直し・省略をしてはいけません。
9. UUIDなどのIDを生成・推測してはいけません。識別にはitem_noだけを使用してください。

【出力形式】
JSONのみ。入力された全件について、次の形式でevaluations配列を返してください。
{
  "evaluations": [
    {"item_no": 1, "relevance_class": "A / B / C / D / review_required", "relevance_reason": "具体的な理由", "relevant_information": "対象スポットに関係する情報。なければ空文字"}
  ]
}

【評価対象】
${JSON.stringify(promptItems, null, 2)}
`;
}

function makeMergePrompt(spotName: string, inputText: string) {
  // 日本時間の現在日付を取得する
  const today = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());

  return `
あなたは地域観光情報を調査・整理する専門家です。
提供された情報源だけを根拠として、対象スポットの情報を統合してください。
このデータは、旅行者が選んだ旅の目的に合わせて、後段のAIが案内を生成するための情報材料です。
完成した旅行者向け紹介文を長く作ることより、事実を目的別に整理することを優先してください。

【現在の日付】
${today}（日本時間）

【対象スポット】
${spotName}

【情報源の分類】
A：対象スポット自身の紹介・基本情報
B：対象スポット固有の歴史・文化・特徴・体験
C：訪問動機につながる地域・周辺情報
Dおよびreview_requiredは統合対象外です。
A/B/Cのページ内でも、別施設や周辺地域の情報が混在する場合があります。
個々の情報が本当に対象スポット自身についてのものか確認してください。
Cの情報を対象スポット自身の住所・営業時間・料金等の根拠にしてはいけません。

【訪問先としての判定】
decisionは accepted / rejected / review_required のいずれか。
accepted：独立した訪問先として成立する場所・施設・自然スポット・店舗・体験施設等。
rejected：イベントそのもの、商品名、作品名、単なる話題・言及など、独立した訪問先ではないもの。
review_required：訪問先である可能性はあるが、情報だけでは判断できないもの。
イベントと開催施設は必ず区別してください。
情報量が少ないことだけを理由にrejectedにしないでください。

【guide_dataの12項目】
次の12キーをすべて出力してください。
1. catchCopy：特徴を短く表す説明
2. topReason：訪問をおすすめする理由
3. highlightPoints：具体的な見どころの配列
4. tags：特徴・分類を表すタグの配列
5. bestSeason：季節に関する情報
6. latestTopics：最新情報・話題。情報源に記載がなければ空文字
7. officialUrl：対象スポット自身の公式URL。確認できなければ空文字
8. recommendFood：名物、特産品、販売商品、飲食店、食べ歩き、食体験など。対象スポット自身と周辺情報を混同せず、どちらの情報か分かるように記載
9. recommendHistory：歴史、由来、人物、建築、文化財、伝承など
10. recommendRelax：自然、景観、庭園、静けさ、休憩場所、癒しの体験など
11. recommendActivity：体験、散策、スポーツ、イベント、参加できる活動など
12. localRecommendation：地域の観光協会・地域情報提供者などが、明示的に推薦・紹介している内容や、情報源に明確に記載された地域ならではのエピソード

【日付・情報の鮮度に関する重要ルール】
1. 必ず「現在の日付」を基準に、情報源に記載された日付が過去・現在・未来のどれに当たるか判断してください。
2. 過去の日付のイベントや開業予定を、未来形や開催予定として記載してはいけません。
3. 過去に開催されたイベントは、必要な場合に限り「過去の開催実績」として扱ってください。現在も開催されていると推測してはいけません。
4. 未来の日付のイベントは、情報源に開催予定として明記されている場合だけ、開催予定として記載してください。
5. 開業日が過去であることだけを根拠に、現在も営業・サービス提供中と断定してはいけません。
6. 営業中・利用可能・予約可能・開催予定などの現在の状況は、情報源にその状態を確認できる記載がある場合だけ断定してください。
7. 情報源に掲載日や更新日がない場合、ページの内容が現在も有効であると決めつけないでください。
8. 年が書かれていないイベント情報は、毎年開催されることが明確に確認できない限り、今年や来年の開催予定として扱わないでください。
9. 日付の年が不明、情報が古い、現在の状況を確認できないなどの場合は、latestTopicsに採用しないでください。無理に補完せず空文字にしてください。
10. 日付を判断するときは、情報源に書かれた開催日・開業日と、ページの掲載日・更新日を混同しないでください。
11. 過去に掲載されたサービス・体験・観光コースについて、現在も提供されていると推測してはいけません。
12. 現在のサービス提供状況を確認できない場合、「提供されています」「利用できます」「開催されています」などの現在形で記載してはいけません。
13. 過去のサービス・体験・観光コースを紹介する場合は、必要に応じて「過去に紹介された」「過去の実施情報」など、時点が分かる表現にしてください。
14. 最新情報として採用するのは、現在の日付と照合して有効性を確認できる情報に限ります。確認できない場合はlatestTopicsを空文字にしてください。

【対象スポットと周辺施設の区別】
1. 対象スポット自身の情報と、近隣施設・周辺地域の情報を明確に区別してください。
2. 周辺施設のサービスやイベントを対象スポット自身が提供しているように書いてはいけません。
3. 周辺施設の情報を記載する場合は、「周辺施設」「近隣施設」などと明示し、対象スポットとの位置づけを分かるようにしてください。
4. 周辺施設の営業・サービス提供状況が確認できない場合、現在利用できると断定してはいけません。
5. 周辺施設の情報は、対象スポットそのものの魅力と混同せず、旅行者の参考になる場合に限って記載してください。
6. カヌー体験、船での周遊、ガイドツアー、キャンプ、飲食サービスなどは、実際の提供主体を確認してください。
7. 対象スポットの近くで実施される活動であっても、対象スポット自身が提供しているとは限りません。提供主体が別施設・事業者の場合は、その施設・事業者のサービスとして記載してください。
8. 提供主体や現在の提供状況が確認できない活動は、現在利用できるサービスとして記載しないでください。
9. 対象スポットそのものの自然環境や歴史的特徴と、事業者が提供する体験サービスを区別してください。

【スポットの位置づけ・親子関係】
次のspot_typeのいずれかを判定してください。
- independent_facility：寺社、博物館、店舗、道の駅など、それ自体が独立した訪問先となる施設
- nested_spot：寺社の奥之院・境内の庭園や堂宇、施設内の展示・見どころなど、別の施設の敷地・管理範囲内にある訪問対象
- standalone_spot：滝、展望地、史跡、巨木など、親施設に属さない単独の場所
- undetermined：情報源だけでは判断できない
nested_spotの場合のみ、親施設の正式名称をsuggested_parent_nameに記載してください。情報源に明確な根拠がない場合は空文字にしてください。
親施設の名前を推測してはいけません。独立した施設と、その敷地内の見どころを混同しないでください。
relationship_reasonには分類根拠を短く記載してください。確証がない場合はundeterminedにしてください。
この分類は提案であり、最終判断は人による審査で行います。

【必ず守ること】
- 情報源にない事実を推測・創作しないでください。不明な文字列は空文字、配列は空配列にしてください。
- 地域の人や観光協会が推薦していると、情報源に明示されていない限り書いてはいけません。一般的なWeb記載を「地元の人の声」「地域のおすすめ」と言い換えないでください。
- localRecommendationには、情報源から推薦主体または地域固有のエピソードが確認できる内容だけを記載してください。
- 過去に掲載された観光コースやイベントを、現在も提供中・開催中であるかのように記載してはいけません。
- recommendFood / recommendHistory / recommendRelax / recommendActivityは、旅行者の4つの目的に応じて後から利用できる情報材料です。情報がない目的は空文字で構いません。
- 住所は対象スポット自身の住所が入力本文に明記されている場合だけ、本文の表記をそのまま出力してください。周辺施設の住所、候補が複数ある住所、推測が必要な住所は空文字にしてください。
- 電話番号、営業時間、定休日、緯度経度は出力しないでください。入力にない値を推測しないでください。
- officialUrlは対象スポット自身の公式サイトと確認できる場合だけ記載してください。
- 情報源URLやページタイトルをGeminiが新たに作らないでください。出典一覧はサーバー側で別途保存します。
- 出力は日本語とし、JSON以外の文章を付けないでください。

【出力JSON形式】
{
  "decision": "accepted / rejected / review_required",
  "decisionReason": "判定理由",
  "spot_type": "independent_facility / nested_spot / standalone_spot / undetermined",
  "suggested_parent_name": "",
  "relationship_reason": "",
  "name": "${spotName}",
  "address": "",
  "guide_data": {
    "catchCopy": "",
    "topReason": "",
    "highlightPoints": [],
    "tags": [],
    "bestSeason": "",
    "latestTopics": "",
    "officialUrl": "",
    "recommendFood": "",
    "recommendHistory": "",
    "recommendRelax": "",
    "recommendActivity": "",
    "localRecommendation": ""
  }
}

【収集した情報】
${inputText}
`;
}

function validateBatch(batchItems: any[], batchEvaluations: any[], batchNumber: number) {
  if (!Array.isArray(batchEvaluations)) throw new Error(`関連性評価バッチ${batchNumber}のJSONにevaluations配列がありません。`);
  const expectedByNumber = new Map<number, string>();
  for (const item of batchItems) {
    if (!Number.isInteger(item.item_no) || typeof item.page_id !== "string" || !item.page_id) {
      throw new Error(`関連性評価バッチ${batchNumber}の入力識別子が不正です。`);
    }
    if (expectedByNumber.has(item.item_no)) throw new Error(`入力item_noが重複しています: ${item.item_no}`);
    expectedByNumber.set(item.item_no, item.page_id);
  }
  const received = new Set<number>();
  const allowed = new Set(["A", "B", "C", "D", "review_required"]);
  const normalized: any[] = [];
  for (const item of batchEvaluations) {
    const itemNo = Number(item.item_no);
    const cls = String(item.relevance_class || "");
    if (!Number.isInteger(itemNo) || !expectedByNumber.has(itemNo)) {
      throw new Error(`対象外または不正なitem_no: ${String(item.item_no ?? "")}`);
    }
    if (received.has(itemNo)) throw new Error(`重複したitem_no: ${itemNo}`);
    if (!allowed.has(cls)) throw new Error(`不正な関連性分類: item_no=${itemNo} / ${cls}`);
    received.add(itemNo);
    // UUIDはAIの返却値を使わず、入力時の対応表からサーバー側で復元する。
    normalized.push({ ...item, page_id: expectedByNumber.get(itemNo)! });
  }
  const missing = [...expectedByNumber.keys()].filter((itemNo) => !received.has(itemNo));
  if (missing.length) throw new Error(`評価不足: ${missing.length}件 (item_no: ${missing.join(", ")})`);
  return normalized;
}

function countCharacters(value: string): number {
  // 80,000文字はUTF-16コード単位ではなくUnicodeコードポイント数で数える。
  return Array.from(value).length;
}

function normalizeGuideData(value: any): GuideData {
  const data = value && typeof value === "object" ? value : {};
  const asText = (v: any) => typeof v === "string" ? v.trim() : "";
  const asStringArray = (v: any) => Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x: string) => x.trim()).filter(Boolean) : [];
  return {
    catchCopy: asText(data.catchCopy),
    topReason: asText(data.topReason),
    highlightPoints: asStringArray(data.highlightPoints),
    tags: asStringArray(data.tags),
    bestSeason: asText(data.bestSeason),
    latestTopics: asText(data.latestTopics),
    officialUrl: asText(data.officialUrl),
    recommendFood: asText(data.recommendFood),
    recommendHistory: asText(data.recommendHistory),
    recommendRelax: asText(data.recommendRelax),
    recommendActivity: asText(data.recommendActivity),
    localRecommendation: asText(data.localRecommendation),
  };
}

async function handleStart(jobId: string, spotName: string, restart: boolean, executionId: string, lockToken: string) {
  const existing = await getMergedRow(jobId, spotName);
  const oldProgress = existing?.relevance_progress;
  const hasPriorState = !!(existing?.relevance_results?.length || oldProgress);
  if (hasPriorState && !restart) {
    return jsonResponse({
      success: false,
      error: "このジョブ・スポットには過去の評価結果または進捗が残っています。続きはcontinue、最初からやり直す場合はmode=restartを指定してください。",
      relevance_status: existing.relevance_status,
      progress: oldProgress,
    }, 409);
  }

  const { sources, candidates } = await buildSources(jobId, spotName);
  const candidateIds = candidates.map((c: any) => String(c.id));
  const sourceUrlIds = [...new Set(sources.flatMap((source: Source) => source.page_ids))];

  if (sources.length === 0) {
    const skippedAt = new Date().toISOString();
    const skippedProgress = {
      job_id: jobId,
      spot_name: spotName,
      ...(restart ? { execution_kind: "facility_recovery", recovery_started_at: new Date().toISOString() } : {}),
      status: "skipped",
      total_pages: 0,
      candidate_ids: candidateIds,
      candidate_count: candidates.length,
      skip_reason: "no_related_pages",
      skipped_at: skippedAt,
      updated_at: skippedAt,
    };
    await saveProgress(jobId, spotName, "skipped", [], skippedProgress, executionId, lockToken, {
      status: "skipped",
      sourceCount: 0,
      inputCharCount: 0,
      sourceCandidateIds: candidateIds,
      sourceUrlIds,
    });
    return jsonResponse({ success: true, mode: "skipped", job_id: jobId, spot_name: spotName, reason: "no_related_pages" });
  }

  const snapshot = sources.map((source) => ({ ...source }));
  const progress = {
    job_id: jobId,
    spot_name: spotName,
    ...(restart ? { execution_kind: "facility_recovery", recovery_started_at: new Date().toISOString() } : {}),
    status: "in_progress",
    total_pages: snapshot.length,
    candidate_ids: candidateIds,
    candidate_count: candidates.length,
    batch_size: RELEVANCE_BATCH_SIZE,
    next_batch: 0,
    batch_attempts: 0,
    completed_batches: [],
    completed_page_ids: [],
    sources: snapshot,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await saveProgress(jobId, spotName, "in_progress", [], progress, executionId, lockToken);
  return jsonResponse({
    success: true,
    mode: restart ? "restart" : "start",
    job_id: jobId,
    spot_name: spotName,
    total_pages: snapshot.length,
    batch_size: RELEVANCE_BATCH_SIZE,
    total_batches: Math.ceil(snapshot.length / RELEVANCE_BATCH_SIZE),
    next_action: "continue",
  });
}

async function handleContinue(jobId: string, spotName: string, executionId: string, lockToken: string) {
  const row = await getMergedRow(jobId, spotName);
  const progress = row?.relevance_progress;
  if (!progress?.sources || !Array.isArray(progress.sources)) {
    return jsonResponse({ success: false, error: "このジョブ・スポットの進捗がありません。先にmode=startを実行してください。" }, 409);
  }
  if (progress.job_id !== jobId || progress.spot_name !== spotName) {
    throw new Error("保存された進捗のjob_idまたはspot_nameが一致しません。");
  }
  if (progress.status === "completed") {
    return jsonResponse({
      success: true,
      mode: "continue",
      message: "関連性評価はすでに完了しています。",
      total_pages: progress.total_pages,
      completed_pages: progress.completed_page_ids?.length || 0,
      next_action: "merge",
    });
  }
  const sources: Source[] = progress.sources;
  const totalBatches = Math.ceil(sources.length / RELEVANCE_BATCH_SIZE);
  const batchIndex = Number(progress.next_batch || 0);
  if (batchIndex >= totalBatches) throw new Error("進捗データのnext_batchが不正です。");

  const items = sources.slice(batchIndex * RELEVANCE_BATCH_SIZE, (batchIndex + 1) * RELEVANCE_BATCH_SIZE).map((source, index) => ({
    item_no: index + 1,
    page_id: source.page_ids[0],
    url: source.url,
    page_title: source.page_title,
    extracted_text: source.extracted_text,
  }));

  const data = await callGemini(RELEVANCE_MODEL, makeRelevancePrompt(spotName, items), 90000);
  const batchResults = validateBatch(items, data?.evaluations, batchIndex + 1);

  const normalized: RelevanceResult[] = batchResults.map((item: any) => {
    const source = sources.find((s) => s.page_ids[0] === String(item.page_id))!;
    return {
      page_id: String(item.page_id),
      page_ids: source.page_ids,
      relevance_class: item.relevance_class,
      relevance_reason: String(item.relevance_reason || ""),
      relevant_information: String(item.relevant_information || ""),
    };
  });
  const allResults: RelevanceResult[] = [...(row.relevance_results || []), ...normalized];
  const completedIds = new Set<string>(progress.completed_page_ids || []);
  for (const result of normalized) completedIds.add(result.page_id);
  const done = allResults.length === sources.length && completedIds.size === sources.length;
  const updatedProgress = {
    ...progress,
    status: done ? "completed" : "in_progress",
    batch_attempts: 0,
    last_error: null,
    next_batch: batchIndex + 1,
    completed_batches: [...(progress.completed_batches || []), batchIndex + 1],
    completed_page_ids: [...completedIds],
    updated_at: new Date().toISOString(),
    last_batch: {
      batch_number: batchIndex + 1,
      page_count: normalized.length,
      completed_at: new Date().toISOString(),
    },
  };
  await saveProgress(jobId, spotName, done ? "completed" : "in_progress", allResults, updatedProgress, executionId, lockToken);
  return jsonResponse({
    success: true,
    mode: "continue",
    job_id: jobId,
    spot_name: spotName,
    batch_number: batchIndex + 1,
    total_batches: totalBatches,
    batch_completed: normalized.length,
    completed_pages: completedIds.size,
    total_pages: sources.length,
    remaining_pages: sources.length - completedIds.size,
    relevance_status: done ? "completed" : "in_progress",
    next_action: done ? "merge" : "continue",
  });
}

async function handleMerge(jobId: string, spotName: string, executionId: string, lockToken: string) {
  const row = await getMergedRow(jobId, spotName);
  const progress = row?.relevance_progress;
  const results: RelevanceResult[] = row?.relevance_results || [];
  if (!progress || progress.status !== "completed" || results.length !== progress.total_pages) {
    return jsonResponse({
      success: false,
      error: "関連性評価が完了していません。全バッチのcontinueを実行してください。",
      relevance_status: row?.relevance_status,
      completed_pages: results.length,
      total_pages: progress?.total_pages ?? null,
    }, 409);
  }
  if (progress.job_id !== jobId || progress.spot_name !== spotName) {
    throw new Error("保存された進捗のjob_idまたはspot_nameが一致しません。");
  }

  const sources: Source[] = progress.sources;
  const evalMap = new Map(results.map((r) => [r.page_id, r]));
  for (const source of sources) {
    const result = evalMap.get(source.page_ids[0]);
    if (!result) throw new Error(`評価結果が見つかりません: ${source.page_ids[0]}`);
    source.relevance_class = result.relevance_class;
    source.relevance_reason = result.relevance_reason;
    source.relevant_information = result.relevant_information;
    source.used_for_merge = ["A", "B", "C"].includes(result.relevance_class);
  }

  const rankOrder: Record<string, number> = { A: 0, B: 1, C: 2 };
  const eligible = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source.used_for_merge)
    .sort((a, b) =>
      rankOrder[String(a.source.relevance_class)] - rankOrder[String(b.source.relevance_class)] ||
      a.index - b.index
    )
    .map(({ source }) => source);

  const serializedSources = () => sources.map((s) => ({
    page_ids: s.page_ids,
    candidate_ids: s.candidate_ids,
    url: s.url,
    page_title: s.page_title,
    categories: s.categories,
    evidence_texts: s.evidence_texts,
    relevance_class: s.relevance_class,
    relevance_reason: s.relevance_reason,
    relevant_information: s.relevant_information,
    used_for_merge: s.used_for_merge,
    sent_to_gemini: s.sent_to_gemini,
  }));
  const candidateIds = [...new Set<string>(progress.candidate_ids || [])];
  const urlIds = [...new Set<string>(sources.flatMap((s) => s.page_ids))];

  if (eligible.length === 0) {
    const skippedAt = new Date().toISOString();
    const skippedProgress = {
      ...progress,
      status: "skipped",
      merge_status: "not_applicable",
      skip_reason: "no_abc_pages",
      skipped_at: skippedAt,
      updated_at: skippedAt,
    };
    const savedId = await saveProgress(jobId, spotName, "skipped", results, skippedProgress, executionId, lockToken, {
      status: "skipped",
      sourceCount: 0,
      inputCharCount: 0,
      sourceCandidateIds: candidateIds,
      sourceUrlIds: urlIds,
      sources: serializedSources(),
    });
    return jsonResponse({
      success: true,
      mode: "merge",
      facility_status: "skipped",
      reason: "no_abc_pages",
      saved_id: savedId,
    });
  }

  let inputText = "";
  let included = 0;
  let bodyCharacterCount = 0;
  for (const source of eligible) {
    const body = source.extracted_text || "";
    const pageCharacters = countCharacters(body);
    if (bodyCharacterCount + pageCharacters > MAX_INPUT_CHARS) {
      // 本文を途中で切らず、最初に上限へ収まらないページが出た時点で選定を終了する。
      break;
    }
    const section = `\n【情報源 ${included + 1}】\n分類: ${source.relevance_class}\nページタイトル: ${source.page_title}\nURL: ${source.url}\n【元ページ本文】\n${body}\n`;
    inputText += section;
    bodyCharacterCount += pageCharacters;
    included++;
    source.sent_to_gemini = true;
  }
  if (!inputText.trim() || included === 0) {
    throw new Error("情報統合対象ページに利用できる本文がありません。");
  }

  console.log("詳細統合 Gemini送信ページ数", included, "本文文字数", bodyCharacterCount);

  const aiResult = await callGemini(MODEL, makeMergePrompt(spotName, inputText), 90000);

  const allowedDecisions = new Set(["accepted", "rejected", "review_required"]);
  const decision = allowedDecisions.has(String(aiResult?.decision)) ? String(aiResult.decision) : "review_required";
  const decisionReason = typeof aiResult?.decisionReason === "string" ? aiResult.decisionReason : "判定理由が返されませんでした。人による確認が必要です。";
  const mergedName = typeof aiResult?.name === "string" && aiResult.name.trim() ? aiResult.name.trim() : spotName;
  const address = typeof aiResult?.address === "string" ? aiResult.address.trim() : "";
  const guideData = normalizeGuideData(aiResult?.guide_data);

  // 座標取得は人による審査段階で明示的に実行する。候補統合時はAPIを呼び出さない。
  const mergedData = {
    decision,
    decisionReason,
    name: mergedName,
    ...(address ? { address } : {}),
    lat: null,
    lng: null,
    geocoding: null,
    location_source: null,
    guide_data: guideData,
  };

  const savedId = await saveProgress(
    jobId,
    spotName,
    "completed",
    results,
    {
      ...progress,
      status: "completed",
      merge_status: "completed",
      merge_attempts: 0,
      merge_error: null,
      merged_at: new Date().toISOString(),
    },
    executionId,
    lockToken,
    {
      status: "completed",
      sourceCount: included,
      inputCharCount: bodyCharacterCount,
      sourceCandidateIds: candidateIds,
      sourceUrlIds: urlIds,
      sources: serializedSources(),
      mergedData,
      model: MODEL,
    },
  );

  return jsonResponse({
    success: true,
    mode: "merge",
    job_id: jobId,
    spot_name: spotName,
    total_pages: sources.length,
    relevance_completed: results.length,
    class_counts: {
      A: results.filter((r) => r.relevance_class === "A").length,
      B: results.filter((r) => r.relevance_class === "B").length,
      C: results.filter((r) => r.relevance_class === "C").length,
      D: results.filter((r) => r.relevance_class === "D").length,
      review_required: results.filter((r) => r.relevance_class === "review_required").length,
    },
    merge_eligible_pages: eligible.length,
    sent_pages: included,
    input_char_count: bodyCharacterCount,
    merged_data: mergedData,
    saved_id: savedId,
    destination_table: TABLE_NAME,
    note: "確認用テーブルへの保存のみです。spotsテーブルには登録していません。",
  });
}

async function readWorkerResponse(response: Response): Promise<any> {
  const result = await response.json();
  if (!response.ok || result?.success === false || result?.error) {
    throw new Error(String(result?.error || result?.detail || `Worker処理に失敗しました (HTTP ${response.status})`));
  }
  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

  if (!supabaseUrl || !serviceRoleKey || !geminiApiKey) {
    return jsonResponse({ error: "SupabaseまたはGeminiの環境変数が不足しています。" }, 500);
  }
  if (
    req.headers.get("authorization") !== `Bearer ${serviceRoleKey}` ||
    req.headers.get("apikey") !== serviceRoleKey
  ) return jsonResponse({ error: "認証に失敗しました。" }, 401);

  try {
    const body = await req.json();
    const jobId = String(body.job_id || "").trim();
    const spotName = String(body.spot_name || "").trim();
    const mode = String(body.mode || "").trim().toLowerCase();
    const executionId = String(body.execution_id || "").trim();
    const lockToken = String(body.lock_token || "").trim();
    const recoveryMode = body.recovery === true;

    if (!jobId || !isUuid(jobId)) return jsonResponse({ error: "job_idは正しいUUID形式で指定してください。" }, 400);
    if (!spotName) return jsonResponse({ error: "spot_nameを指定してください。" }, 400);
    if (!executionId || !isUuid(executionId) || !lockToken || !isUuid(lockToken)) {
      return jsonResponse({ error: "有効なexecution_idとlock_tokenが必要です。" }, 400);
    }

    if (mode !== "process") {
      return jsonResponse({ error: "modeはprocessを指定してください。" }, 400);
    }

    // 施設1件について、関連性評価の全バッチと情報統合を同じEdge Function実行内で完了する。
    // Cronをまたぐ途中再開・自動再試行は行わない。
    let state = await readWorkerResponse(
      await handleStart(jobId, spotName, recoveryMode, executionId, lockToken),
    );
    if (state.mode === "skipped") return jsonResponse(state);

    while (state.next_action === "continue") {
      state = await readWorkerResponse(
        await handleContinue(jobId, spotName, executionId, lockToken),
      );
    }
    if (state.next_action !== "merge") {
      throw new Error("関連性評価の処理状態が不正です。");
    }
    return await handleMerge(jobId, spotName, executionId, lockToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("統合Worker処理エラー:", message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
