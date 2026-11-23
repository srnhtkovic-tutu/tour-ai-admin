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
  priority: number;
  priority_reason: string;
  mention_count: number;
  context_excerpt: string;
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

type GeocodingResult = {
  status: "resolved" | "unresolved" | "no_address" | "error";
  provider: "全国Q地図";
  lat: number | null;
  lng: number | null;
  normalized_address: string | null;
  coordinate_level: string | null;
  match_level: string | null;
  score: number | null;
  map_url: string | null;
  embed_url: string | null;
  attribution: string;
  checked_at: string;
  reason: string;
};

async function geocodeAddress(address: string): Promise<GeocodingResult> {
  const checkedAt = new Date().toISOString();
  const base = {
    provider: "全国Q地図" as const,
    lat: null,
    lng: null,
    normalized_address: null,
    coordinate_level: null,
    match_level: null,
    score: null,
    map_url: null,
    embed_url: null,
    attribution: "住所データ: デジタル庁 アドレス・ベース・レジストリ / 地図: 全国Q地図 (https://qchizu.jp)",
    checked_at: checkedAt,
  };
  const query = String(address || "")
    .replace(/^〒?\s*\d{3}-?\d{4}\s*/, "")
    .trim();
  if (!query) {
    return { ...base, status: "no_address", reason: "住所が登録されていません。" };
  }

  try {
    const url = new URL("https://api.qchizu.jp/geocode.php");
    url.searchParams.set("address", query.slice(0, 500));
    const response = await fetch(url.toString(), {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return { ...base, status: "error", reason: `住所検索サービスがHTTP ${response.status}を返しました。` };
    }
    const payload = await response.json();
    const results = Array.isArray(payload?.results) ? payload.results : [];
    if (!results.length) {
      return {
        ...base,
        attribution: String(payload?.attribution || base.attribution),
        status: "unresolved",
        reason: "住所に一致する位置情報が見つかりませんでした。",
      };
    }

    const candidates = results
      .filter((item: any) => item?.result && typeof item.result === "object")
      .sort((a: any, b: any) => Number(b.result.score || 0) - Number(a.result.score || 0));
    const best = candidates[0];
    if (!best) {
      return { ...base, status: "unresolved", reason: "住所に一致する位置情報が見つかりませんでした。" };
    }

    const result = best.result;
    const rawLat = result.lat;
    const rawLng = result.lon;
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    const score = Number.isFinite(Number(result.score)) ? Number(result.score) : null;
    const coordinateLevel = String(result.coordinate_level || "");
    const matchLevel = String(result.match_level || "");
    const mapUrl = typeof best.links?.qchizu_map === "string" ? best.links.qchizu_map : null;
    const embedUrl = typeof best.links?.qchizu_embed === "string" ? best.links.qchizu_embed : null;
    const attribution = String(payload?.attribution || base.attribution);
    const acceptedLevels = new Set([
      "machiaza_detail",
      "residential_block",
      "residential_detail",
      "parcel",
    ]);
    const coordinatesValid =
      rawLat !== null && rawLat !== undefined &&
      rawLng !== null && rawLng !== undefined &&
      Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
      Number.isFinite(lng) && lng >= -180 && lng <= 180;
    const qualityAccepted =
      coordinatesValid &&
      acceptedLevels.has(coordinateLevel) &&
      score !== null && score >= 0.7 &&
      !!mapUrl && !!attribution;

    if (!qualityAccepted) {
      return {
        ...base,
        normalized_address: typeof result.output === "string" ? result.output : null,
        coordinate_level: coordinateLevel || null,
        match_level: matchLevel || null,
        score,
        map_url: mapUrl,
        embed_url: embedUrl,
        attribution,
        status: "unresolved",
        reason: !coordinatesValid
          ? "住所は照合されましたが、利用可能な座標が返されませんでした。"
          : !acceptedLevels.has(coordinateLevel)
            ? `座標精度が低いため自動設定しませんでした（${coordinateLevel || "不明"}）。`
            : score === null || score < 0.7
              ? "住所の一致度が十分でないため自動設定しませんでした。"
              : "地図リンクまたは出典情報を確認できないため自動設定しませんでした。",
      };
    }

    return {
      ...base,
      lat,
      lng,
      normalized_address: typeof result.output === "string" ? result.output : null,
      coordinate_level: coordinateLevel,
      match_level: matchLevel || null,
      score,
      map_url: mapUrl,
      embed_url: embedUrl,
      attribution,
      status: "resolved",
      reason: "住所から位置情報を取得しました。審査画面で位置を確認してください。",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("住所からの緯度経度取得に失敗:", message);
    return {
      ...base,
      status: "error",
      reason: "住所検索サービスに接続できませんでした。審査画面で位置を手動設定してください。",
    };
  }
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

// ページの内容から、評価時に使う参考優先順位を判定する。
function getPagePriority(source: {
  page_title: string;
  extracted_text: string;
  spot_name: string;
}) {
  const title = source.page_title || "";
  const text = source.extracted_text || "";
  const spotName = source.spot_name || "";
  const normalizeText = (value: string) => value.replace(/\s+/g, "").replace(/　/g, "");
  const normalizedTitle = normalizeText(title);
  const normalizedSpotName = normalizeText(spotName);
  const titleMatchesSpot = normalizedSpotName.length > 0 && normalizedTitle.includes(normalizedSpotName);
  const isEventPage = /イベント|祭り|まつり|体験|開催|参加募集|ワークショップ|ヨガ/.test(title);
  const isFacilityInformation = /施設紹介|スポット紹介|観光案内|施設案内|インフォメーション|営業時間|利用案内|アクセス|料金|入館料/.test(title);
  const contextExcerpts: string[] = [];
  let mentionCount = 0;

  if (spotName.length > 0) {
    let searchPosition = 0;
    while (searchPosition < text.length) {
      const foundPosition = text.indexOf(spotName, searchPosition);
      if (foundPosition === -1) break;
      mentionCount++;
      const start = Math.max(0, foundPosition - 180);
      const end = Math.min(text.length, foundPosition + spotName.length + 180);
      const excerpt = text.slice(start, end).trim();
      if (contextExcerpts.length < 5 && !contextExcerpts.includes(excerpt)) contextExcerpts.push(excerpt);
      searchPosition = foundPosition + spotName.length;
    }
  }

  const contextExcerpt = contextExcerpts.join("\n---\n");
  if (titleMatchesSpot && isFacilityInformation) return { priority: 110, reason: "対象スポットの個別紹介・施設情報", mentionCount, contextExcerpt };
  if (titleMatchesSpot && isEventPage) return { priority: 60, reason: "対象スポットに関連するイベント・体験情報", mentionCount, contextExcerpt };
  if (titleMatchesSpot) return { priority: 100, reason: "タイトルに対象スポット名を含むページ", mentionCount, contextExcerpt };
  if (mentionCount > 0) return { priority: 40, reason: "本文中に対象スポット名あり・関連性の確認が必要", mentionCount, contextExcerpt };
  if (isEventPage) return { priority: 30, reason: "イベント・体験情報", mentionCount, contextExcerpt };
  return { priority: 10, reason: "その他の関連情報", mentionCount, contextExcerpt };
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
    .select("id, name, source_url_id")
    .eq("name", spotName)
    .eq("job_id", jobId)
    .order("id", { ascending: true })
    .range(from, to));
  if (!candidates.length) throw new Error("指定されたジョブ内に該当する候補名が見つかりません。");

  const titlePages = await fetchAllRows((from, to) => supabase
    .from("spot_import_urls")
    .select("id, url, page_title, extracted_text")
    .eq("job_id", jobId)
    .ilike("page_title", `%${spotName}%`)
    .order("id", { ascending: true })
    .range(from, to));

  const textPages = await fetchAllRows((from, to) => supabase
    .from("spot_import_urls")
    .select("id, url, page_title, extracted_text")
    .eq("job_id", jobId)
    .ilike("extracted_text", `%${spotName}%`)
    .order("id", { ascending: true })
    .range(from, to));

  const pageMap = new Map<string, any>();
  for (const page of [...titlePages, ...textPages]) pageMap.set(page.id, page);
  const pages = Array.from(pageMap.values());
  if (!pages.length) throw new Error("指定されたジョブ内に候補名を含む関連ページが見つかりません。");

  const candidateIdsByPage = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (!candidate.source_url_id) continue;
    const ids = candidateIdsByPage.get(candidate.source_url_id) || [];
    ids.push(candidate.id);
    candidateIdsByPage.set(candidate.source_url_id, ids);
  }

  const sourceMap = new Map<string, Source>();
  for (const page of pages) {
    const key = page.url ? normalizeUrl(page.url) : `no-url-${page.id}`;
    const pageCandidateIds = candidateIdsByPage.get(page.id) || [];
    const priorityInfo = getPagePriority({
      page_title: page.page_title || "",
      extracted_text: page.extracted_text || "",
      spot_name: spotName,
    });
    if (sourceMap.has(key)) {
      const existing = sourceMap.get(key)!;
      if (!existing.page_ids.includes(page.id)) existing.page_ids.push(page.id);
      for (const id of pageCandidateIds) if (!existing.candidate_ids.includes(id)) existing.candidate_ids.push(id);
      continue;
    }
    sourceMap.set(key, {
      url: page.url || "",
      page_title: page.page_title || "",
      extracted_text: page.extracted_text || "",
      page_ids: [page.id],
      candidate_ids: [...new Set(pageCandidateIds)],
      categories: [],
      evidence_texts: [],
      priority: priorityInfo.priority,
      priority_reason: priorityInfo.reason,
      mention_count: priorityInfo.mentionCount,
      context_excerpt: priorityInfo.contextExcerpt,
      sent_to_gemini: false,
      used_for_merge: false,
    });
  }
  const sources = Array.from(sourceMap.values()).sort((a, b) =>
    b.priority !== a.priority ? b.priority - a.priority : a.extracted_text.length - b.extracted_text.length
  );
  return { candidates, pages, sources };
}

function makeRelevancePrompt(spotName: string, batchItems: any[]) {
  // GeminiにはUUIDを渡さず、バッチ内だけで有効な連番を識別子として渡す。
  const promptItems = batchItems.map((item) => ({
    item_no: item.item_no,
    url: item.url,
    page_title: item.page_title,
    priority: item.priority,
    mention_count: item.mention_count,
    context_excerpt: item.context_excerpt,
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

【必ず守ること】
- 情報源にない事実を推測・創作しないでください。不明な文字列は空文字、配列は空配列にしてください。
- 地域の人や観光協会が推薦していると、情報源に明示されていない限り書いてはいけません。一般的なWeb記載を「地元の人の声」「地域のおすすめ」と言い換えないでください。
- localRecommendationには、情報源から推薦主体または地域固有のエピソードが確認できる内容だけを記載してください。
- 過去に掲載された観光コースやイベントを、現在も提供中・開催中であるかのように記載してはいけません。
- recommendFood / recommendHistory / recommendRelax / recommendActivityは、旅行者の4つの目的に応じて後から利用できる情報材料です。情報がない目的は空文字で構いません。
- 住所、電話番号、営業時間、定休日、緯度経度は、この出力形式では作らないでください。入力にない値を推測しないでください。
- officialUrlは対象スポット自身の公式サイトと確認できる場合だけ記載してください。
- 情報源URLやページタイトルをGeminiが新たに作らないでください。出典一覧はサーバー側で別途保存します。
- 出力は日本語とし、JSON以外の文章を付けないでください。

【出力JSON形式】
{
  "decision": "accepted / rejected / review_required",
  "decisionReason": "判定理由",
  "name": "${spotName}",
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
  const snapshot = sources.map((source) => ({ ...source }));
  const progress = {
    job_id: jobId,
    spot_name: spotName,
    status: "in_progress",
    total_pages: snapshot.length,
    candidate_ids: candidates.map((c: any) => c.id),
    candidate_count: candidates.length,
    batch_size: RELEVANCE_BATCH_SIZE,
    next_batch: 0,
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
    // バッチ内の連番。実際のpage_idはサーバー側だけで保持する。
    item_no: index + 1,
    page_id: source.page_ids[0],
    url: source.url,
    page_title: source.page_title,
    priority: source.priority,
    mention_count: source.mention_count,
    context_excerpt: source.context_excerpt,
  }));
  console.log(`関連性評価バッチ ${batchIndex + 1}/${totalBatches} 開始`, items.length);
  const data = await callGemini(RELEVANCE_MODEL, makeRelevancePrompt(spotName, items), 90000);
  console.log(`関連性評価バッチ ${batchIndex + 1}/${totalBatches} 入力page_id`, items.map((item) => item.page_id));
  console.log(`関連性評価バッチ ${batchIndex + 1}/${totalBatches} Gemini返却`, (data?.evaluations || []).map((item: any) => ({
    item_no: item.item_no,
    relevance_class: String(item.relevance_class || ""),
  })));

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
  const eligible = sources.filter((s) => s.used_for_merge).sort((a, b) => b.priority - a.priority);
  if (!eligible.length) throw new Error("A・B・Cに分類されたページがありません。");

  let inputText = "";
  let included = 0;
  for (const source of eligible) {
    const section = `\n【情報源 ${included + 1}】\n関連性分類: ${source.relevance_class}\n関連性の判定理由: ${source.relevance_reason}\n対象スポットに関係する情報: ${source.relevant_information}\n\n優先順位: ${source.priority}\nページ分類: ${source.priority_reason}\nページタイトル: ${source.page_title}\nURL: ${source.url}\n対象スポット名の本文中の登場回数: ${source.mention_count}\n\n【対象スポット名の前後の文章】\n${source.context_excerpt}\n\n【元ページ本文】\n${source.extracted_text}\n`;
    if (inputText.length + section.length > MAX_INPUT_CHARS) continue;
    inputText += section;
    included++;
    source.sent_to_gemini = true;
  }
  if (!inputText.trim()) throw new Error("Geminiに渡す情報がありません。");
  console.log("詳細統合 Gemini送信ページ数", included, "文字数", inputText.length);

  const aiResult = await callGemini(MODEL, makeMergePrompt(spotName, inputText), 90000);
  const allowedDecisions = new Set(["accepted", "rejected", "review_required"]);
  const decision = allowedDecisions.has(String(aiResult?.decision)) ? String(aiResult.decision) : "review_required";
  const decisionReason = typeof aiResult?.decisionReason === "string" ? aiResult.decisionReason : "判定理由が返されませんでした。人による確認が必要です。";
  const mergedName = typeof aiResult?.name === "string" && aiResult.name.trim() ? aiResult.name.trim() : spotName;
  const guideData = normalizeGuideData(aiResult?.guide_data);
  // 住所はAIに生成させず、元の候補テーブルから引き継ぐ。
  // progress.candidate_ids は spot_import_page_candidates のIDなので、
  // source_url_id を介して spot_import_candidates の住所と対応付ける。
  const pageCandidateIds: string[] = Array.isArray(progress.candidate_ids)
    ? [...new Set(progress.candidate_ids.filter((id: unknown) => typeof id === "string"))]
    : [];
  let pageCandidates: any[] = [];
  if (pageCandidateIds.length > 0) {
    for (let offset = 0; offset < pageCandidateIds.length; offset += 100) {
      const idChunk = pageCandidateIds.slice(offset, offset + 100);
      const rows = await fetchAllRows((from, to) => supabase
        .from("spot_import_page_candidates")
        .select("id, source_url_id")
        .eq("job_id", jobId)
        .eq("name", spotName)
        .in("id", idChunk)
        .order("id", { ascending: true })
        .range(from, to));
      pageCandidates.push(...rows);
    }
  } else {
    pageCandidates = await fetchAllRows((from, to) => supabase
      .from("spot_import_page_candidates")
      .select("id, source_url_id")
      .eq("job_id", jobId)
      .eq("name", spotName)
      .order("id", { ascending: true })
      .range(from, to));
  }

  const sourceUrlIds = [...new Set(
    pageCandidates
      .map((candidate: any) => candidate.source_url_id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
  )];

  let address = "";
  if (sourceUrlIds.length > 0) {
    const sourceCandidates: any[] = [];
    for (let offset = 0; offset < sourceUrlIds.length; offset += 100) {
      const urlChunk = sourceUrlIds.slice(offset, offset + 100);
      const rows = await fetchAllRows((from, to) => supabase
        .from("spot_import_candidates")
        .select("address")
        .eq("job_id", jobId)
        .eq("name", spotName)
        .in("source_url_id", urlChunk)
        .order("source_url_id", { ascending: true })
        .range(from, to));
      sourceCandidates.push(...rows);
    }

    const distinctAddresses = [...new Set(
      sourceCandidates
        .map((candidate: any) => typeof candidate.address === "string" ? candidate.address.trim() : "")
        .filter((value: string) => value.length > 0)
    )];
    if (distinctAddresses.length === 1) {
      address = distinctAddresses[0];
    } else if (distinctAddresses.length > 1) {
      console.warn("住所候補が複数あり一致しないため、住所を自動引き継ぎしません:", jobId, spotName);
    }
  }

  // 住所の統合後、審査前に住所から緯度・経度を取得する。
  // 低精度・低一致度の座標は自動採用せず、審査担当者による確認に回す。
  const geocoding = await geocodeAddress(address);
  const mergedData = {
    decision,
    decisionReason,
    name: mergedName,
    ...(address ? { address } : {}),
    lat: geocoding.status === "resolved" ? geocoding.lat : null,
    lng: geocoding.status === "resolved" ? geocoding.lng : null,
    geocoding,
    guide_data: guideData,
  };

  const resultSources = sources.map((s) => ({
    page_ids: s.page_ids,
    candidate_ids: s.candidate_ids,
    url: s.url,
    page_title: s.page_title,
    categories: s.categories,
    evidence_texts: s.evidence_texts,
    priority: s.priority,
    priority_reason: s.priority_reason,
    mention_count: s.mention_count,
    context_excerpt: s.context_excerpt,
    relevance_class: s.relevance_class,
    relevance_reason: s.relevance_reason,
    relevant_information: s.relevant_information,
    used_for_merge: s.used_for_merge,
    sent_to_gemini: s.sent_to_gemini,
  }));
  const candidateIds = [...new Set<string>(progress.candidate_ids || [])];
  const urlIds = [...new Set<string>(sources.flatMap((s) => s.page_ids))];
  const savedId = await saveProgress(
    jobId,
    spotName,
    "completed",
    results,
    { ...progress, status: "completed", merged_at: new Date().toISOString() },
    executionId,
    lockToken,
    {
      status: "completed",
      sourceCount: included,
      inputCharCount: inputText.length,
      sourceCandidateIds: candidateIds,
      sourceUrlIds: urlIds,
      sources: resultSources,
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
    merged_data: mergedData,
    saved_id: savedId,
    destination_table: TABLE_NAME,
    note: "確認用テーブルへの保存のみです。spotsテーブルには登録していません。",
  });
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

    if (!jobId || !isUuid(jobId)) return jsonResponse({ error: "job_idは正しいUUID形式で指定してください。" }, 400);
    if (!spotName) return jsonResponse({ error: "spot_nameを指定してください。" }, 400);
    if (!executionId || !isUuid(executionId) || !lockToken || !isUuid(lockToken)) {
      return jsonResponse({ error: "有効なexecution_idとlock_tokenが必要です。" }, 400);
    }

    if (mode === "start") return await handleStart(jobId, spotName, false, executionId, lockToken);
    if (mode === "continue") return await handleContinue(jobId, spotName, executionId, lockToken);
    if (mode === "merge") return await handleMerge(jobId, spotName, executionId, lockToken);
    return jsonResponse({ error: "modeはstart / continue / mergeのいずれかを指定してください。" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("統合Worker処理エラー:", message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
