import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const googleApiKey = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validCoordinates(lat: unknown, lng: unknown) {
  return typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Supabaseの設定が不足しています。" }, 500);

  try {
    const authorization = req.headers.get("Authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!token) return jsonResponse({ error: "ログイン情報を確認できません。再ログインしてください。" }, 401);

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return jsonResponse({ error: "ログイン情報が無効です。再ログインしてください。" }, 401);

    const body = await req.json().catch(() => ({}));
    const regionId = body?.region_id;
    const mode = body?.mode;
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    if (!validUuid(regionId)) return jsonResponse({ error: "地域情報が正しくありません。" }, 400);
    if (mode !== "places" && mode !== "geocode") return jsonResponse({ error: "検索方法が正しくありません。" }, 400);
    if (!query || query.length > 500) return jsonResponse({ error: "検索語を1〜500文字で入力してください。" }, 400);
    if (!googleApiKey) return jsonResponse({ error: "Google Maps APIキーがSupabaseに設定されていません。", code: "GOOGLE_API_KEY_MISSING" }, 503);

    const { data: profile, error: profileError } = await supabase
      .from("user_profiles")
      .select("is_active,is_system_admin")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileError || !profile || !profile.is_active) return jsonResponse({ error: "このアカウントでは利用できません。" }, 403);

    if (!profile.is_system_admin) {
      const { data: assignment, error: assignmentError } = await supabase
        .from("user_regions")
        .select("region_id")
        .eq("user_id", userData.user.id)
        .eq("region_id", regionId)
        .maybeSingle();
      if (assignmentError || !assignment) return jsonResponse({ error: "この地域の位置検索を行う権限がありません。" }, 403);
    }

    if (mode === "places") {
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleApiKey,
          "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types",
        },
        body: JSON.stringify({ textQuery: query, languageCode: "ja", regionCode: "JP" }),
        signal: AbortSignal.timeout(15000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error("Google Places API error", response.status, payload?.error?.status ?? "unknown");
        return jsonResponse({ error: "Google Places検索に失敗しました。API設定または利用状況を確認してください。", google_status: response.status }, 502);
      }
      const places = Array.isArray(payload?.places) ? payload.places : [];
      const results = places.slice(0, 5).flatMap((place: any) => {
        const lat = place?.location?.latitude;
        const lng = place?.location?.longitude;
        if (!validCoordinates(lat, lng)) return [];
        return [{
          provider: "google_places",
          place_id: typeof place.id === "string" ? place.id : null,
          name: typeof place.displayName?.text === "string" ? place.displayName.text : "",
          formatted_address: typeof place.formattedAddress === "string" ? place.formattedAddress : "",
          lat,
          lng,
          types: Array.isArray(place.types) ? place.types : [],
        }];
      });
      return jsonResponse({ ok: true, mode, results });
    }

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", query);
    url.searchParams.set("region", "jp");
    url.searchParams.set("language", "ja");
    url.searchParams.set("key", googleApiKey);
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.status === "REQUEST_DENIED" || payload?.status === "OVER_QUERY_LIMIT") {
      console.error("Google Geocoding API error", response.status, payload?.status ?? "unknown");
      return jsonResponse({ error: "Google Geocoding検索に失敗しました。API設定または利用状況を確認してください。", google_status: payload?.status ?? response.status }, 502);
    }
    const rawResults = Array.isArray(payload?.results) ? payload.results : [];
    const results = rawResults.slice(0, 5).flatMap((item: any) => {
      const lat = item?.geometry?.location?.lat;
      const lng = item?.geometry?.location?.lng;
      if (!validCoordinates(lat, lng)) return [];
      return [{
        provider: "google_geocoding",
        place_id: typeof item.place_id === "string" ? item.place_id : null,
        name: typeof item.formatted_address === "string" ? item.formatted_address : "",
        formatted_address: typeof item.formatted_address === "string" ? item.formatted_address : "",
        lat,
        lng,
        types: Array.isArray(item.types) ? item.types : [],
      }];
    });
    return jsonResponse({ ok: true, mode, google_status: payload?.status ?? "UNKNOWN", results });
  } catch (error) {
    console.error("review-location-search failed", error instanceof Error ? error.message : String(error));
    return jsonResponse({ error: "位置情報検索中にエラーが発生しました。時間をおいて再度お試しください。" }, 500);
  }
});
