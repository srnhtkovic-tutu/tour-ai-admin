import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_HTML_LENGTH = 500_000;
const MAX_TEXT_LENGTH = 12_000;
const MAX_PAGES_PER_RUN = 5;
const MAX_SITEMAPS_PER_RUN = 1;
const MAX_LOCATIONS_PER_SITEMAP = 10_000;
const MAX_DISCOVERED_LINKS_PER_PAGE = 500;

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

function normalizeUrl(value: string, allowedHosts: Set<string>, baseUrl?: string): string | null {
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    if (
      url.protocol !== "https:" ||
      !allowedHosts.has(url.hostname.toLowerCase()) ||
      url.username || url.password || url.port
    ) return null;

    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|yclid|mc_cid|mc_eid)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname.length > 500 || url.href.length > 2048) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isLikelyHtmlPage(value: string): boolean {
  try {
    const path = new URL(value).pathname.toLowerCase();
    if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|mp4|mp3|css|js|xml|json|woff2?)$/i.test(path)) return false;
    if (/\/(search|login|logout|cart|account)(\/|$)/i.test(path)) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchDocument(
  url: string,
  allowedHosts: Set<string>,
): Promise<{ body: string; contentType: string; finalUrl: string }> {
  let currentUrl = normalizeUrl(url, allowedHosts);
  if (!currentUrl) throw new Error("許可されていない取得URLです。");

  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(currentUrl, {
      headers: {
        "User-Agent": "TabitsuzukiSpotImporter/2.1",
        "Accept": "text/html,application/xml,text/xml,text/plain,*/*;q=0.5",
      },
      signal: AbortSignal.timeout(8_000),
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("リダイレクト先URLがありません。");
      if (redirects === 5) throw new Error("リダイレクト回数が上限を超えました。");
      const nextUrl = normalizeUrl(location, allowedHosts, currentUrl);
      if (!nextUrl) throw new Error("許可ドメイン外またはHTTPS以外へのリダイレクトを拒否しました。");
      currentUrl = nextUrl;
      continue;
    }
    if (!response.ok) throw new Error(`取得失敗: HTTP ${response.status}`);

    const contentType = response.headers.get("content-type") ?? "";
    if (!/(text\/html|xml|text\/plain)/i.test(contentType)) {
      throw new Error("HTML/XML以外のファイルです。");
    }
    const body = await response.text();
    if (body.length > MAX_HTML_LENGTH) throw new Error("ページが大きすぎます。");
    return { body, contentType, finalUrl: currentUrl };
  }
  throw new Error("リダイレクト処理を完了できませんでした。");
}

function extractText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return match[1].replace(/<[^>]+>/g, "").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').trim().slice(0, 300) || null;
}

function extractLinks(html: string, baseUrl: string, allowedHosts: Set<string>) {
  const results: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b([^>]*?)href\s*=\s*["']([^"'#]+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null && results.length < MAX_DISCOVERED_LINKS_PER_PAGE) {
    const href = match[2].trim();
    const label = match[4].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const url = normalizeUrl(href, allowedHosts, baseUrl);
    if (!url || url === baseUrl || seen.has(url) || !isLikelyHtmlPage(url)) continue;
    seen.add(url);
    results.push({ url, label: label.slice(0, 300) });
  }
  return results;
}

function extractSitemapLocations(xml: string, allowedHosts: Set<string>): string[] {
  const urls: string[] = [];
  const pattern = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const raw = match[1].trim().replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
    const url = normalizeUrl(raw, allowedHosts);
    if (url) urls.push(url);
  }
  return urls;
}

async function collectSitemapSeeds(rootUrl: string, allowedHosts: Set<string>): Promise<string[]> {
  const root = new URL(rootUrl);
  const seeds = new Set<string>([
    new URL("/sitemap.xml", root.origin).href,
    new URL("/sitemap_index.xml", root.origin).href,
  ]);

  try {
    const robotsUrl = new URL("/robots.txt", root.origin).href;
    const robots = await fetchDocument(robotsUrl, allowedHosts);
    for (const line of robots.body.split(/\r?\n/)) {
      const match = line.match(/^\s*Sitemap:\s*(\S+)/i);
      if (!match) continue;
      const sitemapUrl = normalizeUrl(match[1], allowedHosts, robots.finalUrl);
      if (sitemapUrl) seeds.add(sitemapUrl);
    }
  } catch (error) {
    console.log("robots.txt取得を省略:", String(error));
  }
  return [...seeds];
}

function isSitemapUrl(value: string): boolean {
  return /\.xml(?:\.gz)?(?:$|\?)/i.test(new URL(value).pathname);
}

function isNotFound(error: unknown): boolean {
  return /HTTP 404\b/.test(String(error));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POSTで実行してください。" }, 405);
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "サーバー設定が不足しています。" }, 500);

  // This endpoint is internal: both headers must carry the server-side service key.
  const expected = `Bearer ${serviceRoleKey}`;
  if (req.headers.get("authorization") !== expected || req.headers.get("apikey") !== serviceRoleKey) {
    return jsonResponse({ error: "認証に失敗しました。" }, 401);
  }

  try {
    const body = await req.json();
    const jobId = typeof body.job_id === "string" ? body.job_id : "";
    const executionId = typeof body.execution_id === "string" ? body.execution_id : "";
    const lockToken = typeof body.lock_token === "string" ? body.lock_token : "";
    if (!jobId || !executionId || !lockToken) {
      return jsonResponse({ error: "job_id、execution_id、lock_tokenが必要です。" }, 400);
    }

    const { data: job, error: jobError } = await supabase
      .from("spot_import_jobs")
      .select("id,source_url,region_id,current_stage,status")
      .eq("id", jobId)
      .single();
    if (jobError || !job) throw new Error("対象ジョブを確認できません。");
    if (job.current_stage !== "url_collection" || job.status !== "running") {
      throw new Error("URL収集工程の実行状態ではありません。");
    }

    const { data: region, error: regionError } = await supabase
      .from("regions")
      .select("allowed_domains,is_active")
      .eq("id", job.region_id)
      .single();
    if (regionError || !region || !region.is_active) throw new Error("対象地域が無効か、見つかりません。");

    const allowedHosts = new Set<string>((region.allowed_domains ?? []).map((v: string) => v.toLowerCase()));
    const rootUrl = normalizeUrl(job.source_url, allowedHosts);
    if (!rootUrl) throw new Error("開始URLが地域の許可ドメインに含まれていません。");

    const { data: initialized, error: initializedError } = await supabase.rpc(
      "worker_is_url_collection_initialized",
      { p_job_id: jobId, p_execution_id: executionId, p_lock_token: lockToken },
    );
    if (initializedError) throw initializedError;

    let initializedUrls = 0;
    if (!initialized) {
      const sitemapSeeds = await collectSitemapSeeds(rootUrl, allowedHosts);
      const urls = [
        { url: rootUrl, kind: "page", link_label: "開始ページ", crawl_depth: 0, priority: 100 },
        ...sitemapSeeds.map((url) => ({
          url, kind: "sitemap", discovered_from_url: rootUrl, link_label: "sitemap",
        })),
      ];
      const { data, error } = await supabase.rpc("worker_initialize_url_collection", {
        p_job_id: jobId, p_execution_id: executionId, p_lock_token: lockToken, p_urls: urls,
      });
      if (error) throw error;
      initializedUrls = data ?? 0;
    }

    const { data: sitemapClaimed, error: sitemapClaimError } = await supabase.rpc("worker_claim_sitemap_batch", {
      p_job_id: jobId, p_execution_id: executionId, p_lock_token: lockToken,
      p_limit: MAX_SITEMAPS_PER_RUN,
    });
    if (sitemapClaimError) throw sitemapClaimError;

    let sitemapsCompleted = 0;
    let sitemapPagesAdded = 0;
    let childSitemapsAdded = 0;
    let sitemapsFailed = 0;

    for (const sitemap of (sitemapClaimed ?? [])) {
      try {
        const document = await fetchDocument(sitemap.sitemap_url, allowedHosts);
        const locations = extractSitemapLocations(document.body, allowedHosts);
        if (locations.length > MAX_LOCATIONS_PER_SITEMAP) {
          throw new Error(`サイトマップ内URL数が上限(${MAX_LOCATIONS_PER_SITEMAP})を超えました。`);
        }
        const childSitemaps = locations.filter((url) => isSitemapUrl(url));
        const pageUrls = locations.filter((url) => !isSitemapUrl(url) && isLikelyHtmlPage(url));
        const { data, error } = await supabase.rpc("worker_commit_sitemap", {
          p_job_id: jobId, p_execution_id: executionId, p_lock_token: lockToken,
          p_sitemap_id: sitemap.id, p_success: true,
          p_page_urls: pageUrls.map((url) => ({ url })),
          p_sitemap_urls: childSitemaps.map((url) => ({ url })),
        });
        if (error) throw error;
        sitemapsCompleted++;
        sitemapPagesAdded += Number(data?.pages_added ?? 0);
        childSitemapsAdded += Number(data?.sitemaps_added ?? 0);
      } catch (error) {
        const { error: commitError } = await supabase.rpc("worker_commit_sitemap", {
          p_job_id: jobId, p_execution_id: executionId, p_lock_token: lockToken,
          p_sitemap_id: sitemap.id, p_success: false, p_error: String(error).slice(0, 1800),
        });
        if (commitError) throw commitError;
        sitemapsFailed++;
      }
    }

    const { data: claimed, error: claimError } = await supabase.rpc("worker_claim_url_batch", {
      p_job_id: jobId,
      p_execution_id: executionId,
      p_lock_token: lockToken,
      p_stage: "url_collection",
      p_limit: MAX_PAGES_PER_RUN,
    });
    if (claimError) throw claimError;

    let fetched = 0;
    let failed = 0;
    let skipped = 0;
    let added = 0;

    for (const item of (claimed ?? [])) {
      try {
        const safeUrl = normalizeUrl(item.url, allowedHosts);
        if (!safeUrl) throw new Error("許可されていないURLです。");

        const page = await fetchDocument(safeUrl, allowedHosts);
        if (!page.contentType.toLowerCase().includes("text/html")) {
          const { error } = await supabase.rpc("worker_commit_crawl_page", {
            p_job_id: jobId, p_execution_id: executionId, p_lock_token: lockToken,
            p_url_id: item.id, p_result_status: "skipped",
            p_error: "HTMLページではありません。", p_discovered_urls: [],
          });
          if (error) throw error;
          skipped++;
          continue;
        }

        const extractedText = extractText(page.body);
        if (extractedText.length < 80) {
          const { error } = await supabase.rpc("worker_commit_crawl_page", {
            p_job_id: jobId, p_execution_id: executionId, p_lock_token: lockToken,
            p_url_id: item.id, p_result_status: "skipped",
            p_error: "本文が短いため対象外にしました。", p_discovered_urls: [],
          });
          if (error) throw error;
          skipped++;
          continue;
        }

        const links = extractLinks(page.body, safeUrl, allowedHosts);
        const discovered = links.map((link) => ({
          url: link.url,
          link_label: link.label,
          crawl_depth: (item.crawl_depth ?? 0) + 1,
          priority: /spot|sightseeing|tour|facility|shop|temple|park|miru|見る|観光|施設|寺|神社|公園|店/i.test(
            link.url + " " + link.label,
          ) ? 20 : 0,
        }));

        const { data, error } = await supabase.rpc("worker_commit_crawl_page", {
          p_job_id: jobId, p_execution_id: executionId, p_lock_token: lockToken,
          p_url_id: item.id, p_result_status: "fetched",
          p_page_title: extractTitle(page.body),
          p_extracted_text: extractedText,
          p_discovered_urls: discovered,
        });
        if (error) throw error;
        added += Number(data?.discovered_urls_added ?? 0);
        fetched++;
      } catch (error) {
        const resultStatus = isNotFound(error) ? "skipped" : "failed";
        const { error: commitError } = await supabase.rpc("worker_commit_crawl_page", {
          p_job_id: jobId, p_execution_id: executionId, p_lock_token: lockToken,
          p_url_id: item.id, p_result_status: resultStatus,
          p_error: String(error).slice(0, 1800), p_discovered_urls: [],
        });
        if (commitError) throw commitError;
        if (resultStatus === "skipped") skipped++;
        else failed++;
      }
    }

    const [pendingResult, retryResult, processingResult, sitemapCountsResult] = await Promise.all([
      supabase.from("spot_import_urls").select("id", { count: "exact", head: true })
        .eq("job_id", jobId).eq("crawl_status", "pending"),
      supabase.from("spot_import_urls").select("id", { count: "exact", head: true })
        .eq("job_id", jobId).eq("crawl_status", "failed").lt("retry_count", 2),
      supabase.from("spot_import_urls").select("id", { count: "exact", head: true })
        .eq("job_id", jobId).eq("crawl_status", "processing"),
      supabase.rpc("worker_get_sitemap_queue_counts", { p_job_id: jobId }),
    ]);
    if (pendingResult.error) throw pendingResult.error;
    if (retryResult.error) throw retryResult.error;
    if (processingResult.error) throw processingResult.error;
    if (sitemapCountsResult.error) throw sitemapCountsResult.error;
    const sitemapCounts = sitemapCountsResult.data?.[0] ?? { pending_count: 0, retryable_failed_count: 0 };

    return jsonResponse({
      job_id: jobId,
      stage: "url_collection",
      initialized_urls: initializedUrls,
      claimed_urls: claimed?.length ?? 0,
      pages_fetched: fetched,
      pages_failed: failed,
      pages_skipped: skipped,
      new_urls_added: added,
      sitemaps_claimed: sitemapClaimed?.length ?? 0,
      sitemaps_completed: sitemapsCompleted,
      sitemaps_failed: sitemapsFailed,
      sitemap_pages_added: sitemapPagesAdded,
      child_sitemaps_added: childSitemapsAdded,
      pending_sitemaps: sitemapCounts.pending_count ?? 0,
      retryable_failed_sitemaps: sitemapCounts.retryable_failed_count ?? 0,
      pending_urls: pendingResult.count ?? 0,
      retryable_failed_urls: retryResult.count ?? 0,
      processing_urls: processingResult.count ?? 0,
      has_more_work: (pendingResult.count ?? 0) > 0 || (retryResult.count ?? 0) > 0
        || (sitemapCounts.pending_count ?? 0) > 0 || (sitemapCounts.retryable_failed_count ?? 0) > 0,
    });
  } catch (error) {
    console.error("URL収集Workerエラー:", error);
    return jsonResponse({ error: "URL収集Workerでエラーが発生しました。", detail: String(error).slice(0, 500) }, 500);
  }
});
