const spotFields = [
  "catchCopy","topReason","highlightPoints","tags","bestSeason","latestTopics",
  "officialUrl","recommendFood","recommendHistory","recommendRelax","recommendActivity","localRecommendation"
];
const spotRegionId = new URLSearchParams(window.location.search).get("region");
let editingSpotId = null;
let spotRegionName = "";

const spotMessage = document.getElementById("spotMessage");
const spotList = document.getElementById("spotsList");
const spotEditor = document.getElementById("spotEditor");
const spotForm = document.getElementById("spotForm");

initializeSpotManagement();

async function initializeSpotManagement() {
  const { data: sessionData } = await adminSupabase.auth.getSession();
  if (!sessionData.session) { window.location.replace("admin-login.html"); return; }
  const user = sessionData.session.user;
  const { data: profile, error: profileError } = await adminSupabase.from("user_profiles")
    .select("is_active,is_system_admin").eq("id", user.id).maybeSingle();
  if (profileError || !profile || !profile.is_active) {
    spotMessage.textContent = "このアカウントでは業務画面を利用できません。"; return;
  }
  if (!spotRegionId) { spotMessage.textContent = "地域が指定されていません。地域選択画面から開いてください。"; return; }

  const { data: region, error: regionError } = await adminSupabase.from("regions")
    .select("id,name,is_active").eq("id", spotRegionId).maybeSingle();
  if (regionError || !region || !region.is_active) {
    spotMessage.textContent = "地域を確認できません。地域選択画面から選び直してください。"; return;
  }
  if (!profile.is_system_admin) {
    const { data: assignment, error: assignmentError } = await adminSupabase.from("user_regions")
      .select("region_id").eq("user_id", user.id).eq("region_id", spotRegionId).maybeSingle();
    if (assignmentError || !assignment) {
      spotMessage.textContent = "この地域を利用する権限がありません。"; return;
    }
  }
  spotRegionName = region.name;
  document.getElementById("regionNameHeader").textContent = region.name;
  document.getElementById("reviewCandidatesLink").href = "admin-review.html?region=" + encodeURIComponent(spotRegionId);
  spotMessage.textContent = region.name + " のスポットを管理します。";
  document.getElementById("newSpotButton").addEventListener("click", () => openSpotEditor(null));
  document.getElementById("cancelEditorButton").addEventListener("click", closeSpotEditor);
  document.getElementById("discardSpotButton").addEventListener("click", closeSpotEditor);
  document.getElementById("searchButton").addEventListener("click", loadSpotList);
  document.getElementById("spotSearch").addEventListener("keydown", e => { if(e.key==="Enter"){e.preventDefault();loadSpotList();} });
  document.getElementById("lookupAddressButton").addEventListener("click", lookupAddress);
  spotForm.addEventListener("submit", saveSpot);
  await loadSpotList();
}

async function loadSpotList() {
  spotList.replaceChildren();
  const search = document.getElementById("spotSearch").value.trim();
  spotMessage.textContent = "スポットを読み込んでいます...";
  let query = adminSupabase.from("spots")
    .select("id,name,address,lat,lng,guide_data,create_at,updated_at")
    .eq("region_id", spotRegionId).order("create_at", { ascending: false });
  if (search) query = query.ilike("name", "%" + search + "%");
  const { data, error } = await query;
  if (error) {
    spotMessage.textContent = "スポットを読み込めませんでした。";
    console.error(error); return;
  }
  spotMessage.textContent = spotRegionName + " ・ " + data.length + "件";
  if (!data.length) {
    const empty = document.createElement("p"); empty.className="empty-state";
    empty.textContent = "登録されているスポットはありません。"; spotList.append(empty); return;
  }
  data.forEach(spot => {
    const row=document.createElement("div"); row.className="spot-row";
    const info=document.createElement("div");
    const name=document.createElement("strong"); name.textContent=spot.name;
    const meta=document.createElement("small"); meta.textContent=spot.address || "住所未登録";
    info.append(name,meta);
    const actions=document.createElement("div"); actions.className="spot-actions";
    const edit=document.createElement("button"); edit.className="secondary-button"; edit.textContent="編集";
    edit.addEventListener("click",()=>openSpotEditor(spot));
    const remove=document.createElement("button"); remove.className="secondary-button"; remove.textContent="削除";
    remove.addEventListener("click",()=>deleteSpot(spot));
    actions.append(edit,remove); row.append(info,actions); spotList.append(row);
  });
}

function openSpotEditor(spot) {
  editingSpotId = spot ? spot.id : null;
  document.getElementById("editorTitle").textContent = spot ? "スポット編集" : "スポット新規登録";
  document.getElementById("formError").textContent = "";
  spotForm.reset();
  document.getElementById("spotName").value = spot?.name || "";
  document.getElementById("spotAddress").value = spot?.address || "";
  document.getElementById("spotLat").value = spot?.lat ?? "";
  document.getElementById("spotLng").value = spot?.lng ?? "";
  const guide = spot?.guide_data || {};
  spotFields.forEach(key => {
    const el=document.getElementById(key);
    const value=guide[key];
    el.value=Array.isArray(value)?value.join("\n"):(value ?? "");
  });
  document.getElementById("addressResults").replaceChildren();
  spotEditor.classList.remove("hidden");
  spotEditor.scrollIntoView({behavior:"smooth",block:"start"});
}

function closeSpotEditor() {
  spotForm.reset(); editingSpotId=null;
  document.getElementById("formError").textContent="";
  document.getElementById("addressResults").replaceChildren();
  spotEditor.classList.add("hidden");
}

function buildGuideData() {
  const guide = {};
  spotFields.forEach(key => {
    const value=document.getElementById(key).value.trim();
    if (key==="highlightPoints" || key==="tags") {
      guide[key]=value ? value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean) : [];
    } else guide[key]=value;
  });
  return guide;
}

async function saveSpot(event) {
  event.preventDefault();
  const button=document.getElementById("saveSpotButton");
  const errorBox=document.getElementById("formError");
  const name=document.getElementById("spotName").value.trim();
  const address=document.getElementById("spotAddress").value.trim();
  const latValue=document.getElementById("spotLat").value.trim();
  const lngValue=document.getElementById("spotLng").value.trim();
  const guide=buildGuideData();
  if (!name || name.length>100) { errorBox.textContent="スポット名を1〜100文字で入力してください。"; return; }
  if (address.length>200) { errorBox.textContent="住所は200文字以内で入力してください。"; return; }
  for (const key of spotFields) {
    const value=document.getElementById(key).value;
    const limit=key==="officialUrl"?2000:2000;
    if (!["highlightPoints","tags"].includes(key) && value.length>limit) {
      errorBox.textContent="入力内容が最大2000文字を超えています。"; document.getElementById(key).focus(); return;
    }
  }
  const lat=latValue===""?null:Number(latValue), lng=lngValue===""?null:Number(lngValue);
  if ((latValue!=="" && !Number.isFinite(lat)) || (lngValue!=="" && !Number.isFinite(lng))) { errorBox.textContent="緯度・経度を数値で入力してください。"; return; }
  if ((lat===null)!==(lng===null)) { errorBox.textContent="緯度と経度は両方入力してください。"; return; }
  if (lat!==null && (lat < -90 || lat > 90 || lng < -180 || lng > 180)) { errorBox.textContent="緯度・経度の範囲が正しくありません。"; return; }

  const isNewSpot = editingSpotId===null;
  button.disabled=true; button.textContent="保存しています...";
  let result;
  if (isNewSpot) {
    result=await adminSupabase.rpc("create_region_spot",{p_region_id:spotRegionId,p_name:name,p_address:address||null,p_lat:lat,p_lng:lng,p_guide_data:guide});
  } else {
    result=await adminSupabase.rpc("update_region_spot",{p_spot_id:editingSpotId,p_name:name,p_address:address||null,p_lat:lat,p_lng:lng,p_guide_data:guide});
  }
  button.disabled=false; button.textContent="保存する";
  if (result.error) {
    errorBox.textContent=result.error.message || "保存できませんでした。入力内容をご確認ください。";
    return;
  }
  closeSpotEditor();
  spotMessage.textContent=isNewSpot?"スポットを登録しました":"スポットを更新しました";
  await loadSpotList();
}

async function deleteSpot(spot) {
  if (!window.confirm("「"+spot.name+"」を削除しますか？\n削除したスポットは元に戻せません。")) return;
  const { error }=await adminSupabase.rpc("delete_region_spot",{p_spot_id:spot.id});
  if (error) { spotMessage.textContent=error.message || "スポットを削除できませんでした。"; return; }
  spotMessage.textContent="スポットを削除しました。";
  await loadSpotList();
}

async function lookupAddress() {
  const query=document.getElementById("spotAddress").value.trim();
  const results=document.getElementById("addressResults");
  results.replaceChildren();
  if (!query) { results.textContent="住所や施設名を入力してください。"; return; }
  const button=document.getElementById("lookupAddressButton"); button.disabled=true; button.textContent="検索中...";
  try {
    const url="https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&country=Japan&q="+encodeURIComponent(query);
    const response=await fetch(url,{headers:{"Accept":"application/json"}});
    if (!response.ok) throw new Error("lookup failed");
    const matches=await response.json();
    if (!matches.length) { results.textContent="候補が見つかりませんでした。住所を修正して再検索してください。"; return; }
    matches.forEach(match=>{
      const option=document.createElement("button"); option.type="button";
      option.textContent=match.display_name;
      option.addEventListener("click",()=>{
        document.getElementById("spotAddress").value=match.display_name.slice(0,200);
        document.getElementById("spotLat").value=match.lat;
        document.getElementById("spotLng").value=match.lon;
        results.replaceChildren();
      });
      results.append(option);
    });
  } catch(error) {
    results.textContent="住所検索を利用できませんでした。住所と緯度・経度を手入力してください。";
  } finally { button.disabled=false; button.textContent="住所を検索"; }
}
