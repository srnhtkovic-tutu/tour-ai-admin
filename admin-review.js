const REVIEW_FIELDS = ["catchCopy","topReason","highlightPoints","tags","bestSeason","latestTopics","officialUrl","recommendFood","recommendHistory","recommendRelax","recommendActivity","localRecommendation"];
const reviewRegionId = new URLSearchParams(location.search).get("region");
let reviewUserId = null;
let reviewRegionName = "";
let reviewCandidates = [];
let selectedReviewId = null;

const reviewMessage = document.getElementById("reviewMessage");
const candidateList = document.getElementById("reviewCandidateList");
const reviewEditor = document.getElementById("reviewEditor");

initializeReview();

async function initializeReview() {
  const {data: sessionData} = await adminSupabase.auth.getSession();
  if (!sessionData.session) { location.replace("admin-login.html"); return; }
  reviewUserId = sessionData.session.user.id;
  const {data: profile,error:profileError} = await adminSupabase.from("user_profiles")
    .select("is_active,is_system_admin").eq("id",reviewUserId).maybeSingle();
  if (profileError || !profile || !profile.is_active) { reviewMessage.textContent="このアカウントでは利用できません。"; return; }
  if (!reviewRegionId) { reviewMessage.textContent="地域が指定されていません。"; return; }
  const {data:region,error:regionError} = await adminSupabase.from("regions")
    .select("id,name,is_active").eq("id",reviewRegionId).maybeSingle();
  if (regionError || !region || !region.is_active) { reviewMessage.textContent="地域を確認できません。"; return; }
  if (!profile.is_system_admin) {
    const {data:assignment,error} = await adminSupabase.from("user_regions")
      .select("region_id").eq("user_id",reviewUserId).eq("region_id",reviewRegionId).maybeSingle();
    if (error || !assignment) { reviewMessage.textContent="この地域の審査権限がありません。"; return; }
  }
  reviewRegionName=region.name;
  document.getElementById("reviewRegionHeader").textContent=region.name+" ・ AI審査";
  const back="admin-spots.html?region="+encodeURIComponent(reviewRegionId);
  document.getElementById("backToSpots").href=back;
  await loadReviewCandidates();
}

async function loadReviewCandidates() {
  reviewMessage.textContent="審査候補を読み込んでいます...";
  candidateList.replaceChildren();
  const {data,error}=await adminSupabase.from("spot_import_merged_v2")
    .select("id,job_id,region_id,spot_name,status,source_count,sources,merged_data,reviewed_data,review_status,relevance_results,created_at")
    .eq("region_id",reviewRegionId)
    .eq("status","completed").filter("merged_data->>decision","eq","accepted").eq("review_status","pending")
    .order("created_at",{ascending:false});
  if(error){reviewMessage.textContent="審査候補を読み込めませんでした。DB権限を確認してください。";console.error(error);return;}
  reviewCandidates=data||[];
  reviewMessage.textContent=reviewRegionName+" ・ 審査待ち "+reviewCandidates.length+"件";
  if(!reviewCandidates.length){
    const empty=document.createElement("p");empty.className="empty-state";empty.textContent="審査待ちの候補はありません。";
    candidateList.append(empty);reviewEditor.replaceChildren();return;
  }
  reviewCandidates.forEach(candidate=>{
    const button=document.createElement("button");button.type="button";button.className="review-candidate";
    button.dataset.candidateId=candidate.id;
    button.setAttribute("aria-current",candidate.id===selectedReviewId?"true":"false");
    const title=document.createElement("strong");title.textContent=candidate.spot_name;
    const meta=document.createElement("small");meta.textContent="情報元 "+(candidate.source_count||0)+"件";
    button.append(title,meta);
    button.addEventListener("click",()=>renderCandidate(candidate.id));
    candidateList.append(button);
  });
  if(!selectedReviewId || !reviewCandidates.some(c=>c.id===selectedReviewId)) selectedReviewId=reviewCandidates[0].id;
  renderCandidate(selectedReviewId);
}

function element(tag, text, className) {
  const node=document.createElement(tag);
  if(text!==undefined && text!==null) node.textContent=String(text);
  if(className) node.className=className;
  return node;
}

function renderCandidate(id) {
  const candidate=reviewCandidates.find(c=>c.id===id);
  if(!candidate)return;
  selectedReviewId=id;
  candidateList.querySelectorAll("button").forEach(b=>b.setAttribute("aria-current",b.dataset.candidateId===candidate.id?"true":"false"));
  reviewEditor.replaceChildren();

  const ai=candidate.merged_data||{};
  const base=candidate.reviewed_data||ai;
  const guide=base.guide_data||ai.guide_data||{};
  const sourcePanel=element("div",null,"panel");
  sourcePanel.append(element("h2","AIによる判定・情報源"));
  sourcePanel.append(element("p","AI判定: "+(ai.decision||"未設定")+" ／ 情報元: "+(candidate.source_count||0)+"件","review-meta"));
  if(ai.decisionReason) sourcePanel.append(element("div",ai.decisionReason,"review-decision"));
  const geocoding=base.geocoding||ai.geocoding||null;
  if(geocoding){
    const geoPanel=element("div",null,"review-source");
    geoPanel.append(element("h3","住所からの位置情報"));
    const statusLabel=geocoding.status==="resolved"?"自動取得済み（審査で位置を確認してください）":geocoding.status==="no_address"?"住所なし":geocoding.status==="error"?"住所検索サービスに接続できませんでした":"位置を特定できませんでした";
    geoPanel.append(element("p",statusLabel,"review-meta"));
    if(geocoding.reason)geoPanel.append(element("p",geocoding.reason,"review-meta"));
    if(geocoding.coordinate_level)geoPanel.append(element("p","座標精度: "+geocoding.coordinate_level+" ／ 一致度: "+(geocoding.score??"不明"),"review-meta"));
    if(geocoding.map_url&&/^https:\/\/qchizu\.jp\//i.test(geocoding.map_url)){
      const mapLink=element("a","全国Q地図で位置を確認");mapLink.href=geocoding.map_url;mapLink.target="_blank";mapLink.rel="noopener noreferrer";geoPanel.append(mapLink);
    }
    if(geocoding.attribution)geoPanel.append(element("p",geocoding.attribution,"review-meta"));
    sourcePanel.append(geoPanel);
  }
  const sources=Array.isArray(candidate.sources)?candidate.sources:[];
  if(sources.length){
    sourcePanel.append(element("h3","収集したページ"));
    sources.forEach(source=>{
      const wrap=element("div",null,"review-source");
      const title=source.page_title||source.title||source.name||source.url||"情報元ページ";
      const url=source.url||source.source_url;
      if(url && /^https?:\/\//i.test(url)){
        const link=element("a",title);link.href=url;link.target="_blank";link.rel="noopener noreferrer";wrap.append(link);
      } else wrap.append(element("span",title));
      if(source.relevance_class)wrap.append(element("div","関連度 "+source.relevance_class,"review-meta"));
      if(source.relevance_reason)wrap.append(element("p",source.relevance_reason,"review-meta"));
      if(source.relevant_information)wrap.append(element("p",source.relevant_information));
      sourcePanel.append(wrap);
    });
  }
  const relevance=Array.isArray(candidate.relevance_results)?candidate.relevance_results:[];
  if(relevance.length){
    sourcePanel.append(element("h3","情報の関連性評価"));
    relevance.forEach(item=>{
      const line=element("p",(item.relevance_class||"")+"： "+(item.relevant_information||item.relevance_reason||""),"review-meta");
      sourcePanel.append(line);
    });
  }
  reviewEditor.append(sourcePanel);

  const panel=element("section",null,"panel");
  panel.append(element("h2","内容の確認・編集"));
  const form=element("form");form.id="reviewForm";form._geocoding=geocoding;
  const mapPanel=element("div",null,"review-map-panel");
  mapPanel.append(element("h3","地図で位置を設定"));
  mapPanel.append(element("p","地図をクリックすると、その場所にマーカーが移動して緯度・経度に反映されます。マーカーをドラッグして微調整することもできます。","review-meta"));
  const mapNode=element("div",null,"review-location-map");mapNode.id="reviewLocationMap";mapPanel.append(mapNode);
  const mapStatus=element("p","地図を読み込んでいます...","review-meta");mapStatus.id="reviewMapStatus";mapPanel.append(mapStatus);
  const grid=element("div",null,"form-grid");
  addField(grid,"reviewName","スポット名（必須・100文字以内）",base.name||candidate.spot_name,"text",100,true,true);
  addField(grid,"reviewAddress","住所（200文字以内）",base.address||"","text",200,true);
  addField(grid,"reviewLat","緯度",base.lat??"","number",null,false);
  addField(grid,"reviewLng","経度",base.lng??"","number",null,false);
  REVIEW_FIELDS.forEach(key=>{
    const value=guide[key];
    const val=Array.isArray(value)?value.join("\n"):(value??"");
    const label=({catchCopy:"キャッチコピー",topReason:"おすすめする理由",highlightPoints:"見どころ（1行に1項目）",tags:"タグ（1行に1項目）",bestSeason:"おすすめの季節",latestTopics:"最近の話題",officialUrl:"公式サイトURL",recommendFood:"グルメ",recommendHistory:"歴史・文化",recommendRelax:"癒やし",recommendActivity:"自然・体験",localRecommendation:"地元の人からのおすすめ"})[key];
    addField(grid,"review_"+key,label,val,"textarea",key==="highlightPoints"||key==="tags"?null:2000,true,key==="catchCopy"||key==="topReason"||key==="highlightPoints"||key==="tags"||key==="localRecommendation");
  });
  form.append(mapPanel,grid);
  const error=element("p","","form-error");error.id="reviewFormError";form.append(error);
  const actions=element("div",null,"review-action-row");
  const save=element("button","修正内容を保存");save.type="button";save.addEventListener("click",()=>saveReview(candidate.id,form,error,save));
  const approve=element("button","承認して本番登録");approve.type="button";approve.addEventListener("click",()=>approveReview(candidate.id,form,error,approve));
  const reject=element("button","不採用にする","secondary-button");reject.type="button";reject.addEventListener("click",()=>rejectReview(candidate));
  actions.append(save,approve,reject);form.append(actions);panel.append(form);reviewEditor.append(panel);
  initializeReviewMap(
    Object.prototype.hasOwnProperty.call(base,"lat")?base.lat:(ai.lat??null),
    Object.prototype.hasOwnProperty.call(base,"lng")?base.lng:(ai.lng??null)
  );
}

let reviewMap=null;
let reviewMapMarker=null;

function initializeReviewMap(initialLat,initialLng){
  if(reviewMap)reviewMap.remove();
  reviewMap=null;reviewMapMarker=null;
  const mapStatus=document.getElementById("reviewMapStatus");
  const mapElement=document.getElementById("reviewLocationMap");
  if(!mapElement||!window.L){if(mapStatus)mapStatus.textContent="地図ライブラリを読み込めませんでした。緯度・経度を直接入力してください。";return;}
  const hasInitial=Number.isFinite(Number(initialLat))&&initialLat!==null&&initialLat!==""&&Number.isFinite(Number(initialLng))&&initialLng!==null&&initialLng!=="";
  const start=hasInitial?[Number(initialLat),Number(initialLng)]:[36.5,138.0];
  reviewMap=L.map(mapElement).setView(start,hasInitial?16:5);
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",{
    maxZoom:18,
    attribution:'<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル（国土地理院）</a>'
  }).addTo(reviewMap);
  if(hasInitial)placeReviewMarker(start[0],start[1],false);
  reviewMap.on("click",event=>{
    placeReviewMarker(event.latlng.lat,event.latlng.lng,true);
    if(mapStatus)mapStatus.textContent="地図で選択した位置を緯度・経度欄に反映しました。";
  });
  ["reviewLat","reviewLng"].forEach(id=>{
    document.getElementById(id).addEventListener("change",()=>{
      const lat=Number(document.getElementById("reviewLat").value);
      const lng=Number(document.getElementById("reviewLng").value);
      if(!Number.isFinite(lat)||!Number.isFinite(lng)||lat < -90||lat>90||lng < -180||lng>180)return;
      placeReviewMarker(lat,lng,false);
      reviewMap.setView([lat,lng],Math.max(reviewMap.getZoom(),16));
    });
  });
  setTimeout(()=>reviewMap.invalidateSize(),0);
  if(mapStatus)mapStatus.textContent=hasInitial?"現在の登録候補位置を表示しています。地図をクリックして調整できます。":"位置が未設定です。地図を移動・拡大して、スポットの場所をクリックしてください。";
}

function placeReviewMarker(lat,lng,updateFields){
  if(!reviewMap)return;
  const position=[lat,lng];
  if(!reviewMapMarker){
    reviewMapMarker=L.marker(position,{draggable:true}).addTo(reviewMap);
    reviewMapMarker.on("dragend",()=>{
      const p=reviewMapMarker.getLatLng();
      placeReviewMarker(p.lat,p.lng,true);
    });
  }else reviewMapMarker.setLatLng(position);
  if(updateFields){
    document.getElementById("reviewLat").value=lat.toFixed(7);
    document.getElementById("reviewLng").value=lng.toFixed(7);
  }
}

function addField(grid,id,label,value,type,maxLength,full=false,required=false){
  const wrap=element("div",null,"field"+(full?" full":""));
  const lab=element("label",label);lab.htmlFor=id;wrap.append(lab);
  const input=type==="textarea"?document.createElement("textarea"):document.createElement("input");
  input.id=id;input.value=value??"";
  if(type!=="textarea")input.type=type;
  if(maxLength)input.maxLength=maxLength;
  if(type==="number")input.step="any";
  if(required)input.required=true;
  if(type==="textarea")input.rows= id.includes("highlight")||id.includes("tags")?4:3;
  wrap.append(input);grid.append(wrap);
}

function collectReviewData(form){
  const name=form.querySelector("#reviewName").value.trim();
  const address=form.querySelector("#reviewAddress").value.trim();
  const latText=form.querySelector("#reviewLat").value.trim();
  const lngText=form.querySelector("#reviewLng").value.trim();
  const guide={};
  REVIEW_FIELDS.forEach(key=>{
    const value=form.querySelector("#review_"+key).value.trim();
    guide[key]=(key==="highlightPoints"||key==="tags")?(value?value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean):[]):value;
  });
  const lat=latText===""?null:Number(latText);
  const lng=lngText===""?null:Number(lngText);
  const geocoding=form._geocoding||null;
  const sameAsGeocoding=!!geocoding&&geocoding.status==="resolved"&&lat===geocoding.lat&&lng===geocoding.lng;
  return {name,address,lat,lng,guide_data:guide,geocoding,location_source:lat!==null&&lng!==null?(sameAsGeocoding?"全国Q地図":"manual_review"):null};
}

async function saveReview(id,form,error,button){
  error.textContent="";
  const data=collectReviewData(form);
  if(!data.name||data.name.length>100){error.textContent="スポット名を1〜100文字で入力してください。";return;}
  if(data.address.length>200){error.textContent="住所は200文字以内で入力してください。";return;}
  if((data.lat===null)!==(data.lng===null)|| (data.lat!==null&&(!Number.isFinite(data.lat)||!Number.isFinite(data.lng)||data.lat < -90||data.lat>90||data.lng < -180||data.lng>180))){error.textContent="緯度・経度を正しく入力してください。";return;}
  if(data.guide_data.officialUrl.length>2000){error.textContent="公式サイトURLは2000文字以内で入力してください。";return;}
  for(const key of REVIEW_FIELDS){if(!["highlightPoints","tags"].includes(key)&&String(data.guide_data[key]||"").length>2000){error.textContent="各紹介項目は2000文字以内で入力してください。";form.querySelector("#review_"+key).focus();return;}}
  button.disabled=true;
  const {error:rpcError}=await adminSupabase.rpc("save_spot_import_review",{p_candidate_id:id,p_reviewed_data:data});
  button.disabled=false;
  if(rpcError){error.textContent=rpcError.message||"修正内容を保存できませんでした。";return;}
  reviewMessage.textContent="修正内容を保存しました。";
  const found=reviewCandidates.find(c=>c.id===id);if(found)found.reviewed_data=data;
}

async function approveReview(id,form,error,button){
  error.textContent="";
  const data=collectReviewData(form);
  if(!data.name||data.name.length>100){error.textContent="スポット名を1〜100文字で入力してください。";return;}
  if(data.address.length>200){error.textContent="住所は200文字以内で入力してください。";return;}
  if((data.lat===null)!==(data.lng===null)||(data.lat!==null&&(!Number.isFinite(data.lat)||!Number.isFinite(data.lng)||data.lat < -90||data.lat>90||data.lng < -180||data.lng>180))){error.textContent="緯度・経度を正しく入力してください。";return;}
  if(data.lat===null||data.lng===null){error.textContent="位置情報が未設定です。緯度・経度を設定してから承認してください。";form.querySelector("#reviewLat").focus();return;}
  if(!window.confirm("「"+data.name+"」を承認し、本番スポットとして登録しますか？"))return;
  button.disabled=true;button.textContent="登録しています...";
  const {error:saveError}=await adminSupabase.rpc("save_spot_import_review",{p_candidate_id:id,p_reviewed_data:data});
  if(saveError){button.disabled=false;button.textContent="承認して本番登録";error.textContent=saveError.message;return;}
  const {data:spotId,error:approveError}=await adminSupabase.rpc("approve_spot_import_review",{p_candidate_id:id});
  button.disabled=false;button.textContent="承認して本番登録";
  if(approveError){error.textContent=approveError.message||"本番登録できませんでした。";return;}
  reviewMessage.textContent="承認して本番登録しました（スポットID: "+spotId+"）。";
  await loadReviewCandidates();
}

async function rejectReview(candidate){
  if(!window.confirm("「"+candidate.spot_name+"」を不採用にしますか？"))return;
  const {error}=await adminSupabase.rpc("reject_spot_import_review",{p_candidate_id:candidate.id});
  if(error){reviewMessage.textContent=error.message||"不採用にできませんでした。";return;}
  reviewMessage.textContent="不採用にしました。";
  await loadReviewCandidates();
}
