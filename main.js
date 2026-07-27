let spots = [];
const SUPABASE_URL = "https://fugibstqzkmzplqrpovn.supabase.co";
const SUPABASE_KEY = "sb_publishable_CM7-Kj4GEFY0oG2EI3t-XQ_MijxwUcZ";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

// =========================
// spots読み込み処理
// =========================
async function loadSpots() {

  const { data, error } = await supabaseClient
    .from("spots")
    .select("*");

  if (error) {
    console.error(error);
    return [];
  }

  console.log(data);

  console.log(
    JSON.stringify(data, null, 2)
  );

return data.map(spot => ({

  id: spot.id,
  name: spot.name,
  lat: Number(spot.lat),
  lng: Number(spot.lng),
  imageUrl: spot.image_url,
  guideData: spot.guide_data,

  catchCopy: spot.guide_data.catchCopy,
  topReason: spot.guide_data.topReason,
  ownerExperience: spot.guide_data.ownerExperience,
  highlightPoints: spot.guide_data.highlightPoints

}));

}

// =========================
// 設定値
// =========================

// 案内開始距離
let triggerDistance = 30000;

// 離脱判定距離
const LEAVE_DISTANCE = 100;

// 滞在必要時間
const STAY_TIME = 1 * 1000;

// 案内クールタイム
const GUIDE_COOLDOWN =
  5 * 60 * 1000;


// =========================
// 状態管理
// =========================

// 現在対象スポット
let currentSpot = null;

// 接近開始時間
let enterTime = null;

// 最後に案内した時刻
const lastGuideTime = {};

// 興味なしスポット
const ignoredSpots = new Set();

// 訪問済みスポット
const visitedSpots = new Set();

// 案内中フラグ
let guideActive = false;

// GoogleMap案内中
let guidePaused = false;

// スポット情報表示状態
let spotInfoOpen = true;

// =========================
// AIチャット履歴
// =========================
let chatHistory = [];

// =========================
// ユーザータイプ
// =========================
let userType = "歴史・文化探訪";

// =========================
// スライダー
// =========================

const slider =
  document.getElementById(
    "distanceSlider"
  );

const distanceValue =
  document.getElementById(
    "distanceValue"
  );

slider.addEventListener(
  "input",
  function () {

    triggerDistance =
      Number(slider.value);

    distanceValue.textContent =
      triggerDistance;

  }
);


// =========================
// GPS監視開始
// =========================

function startWatch() {

  if (!navigator.geolocation) {

    alert("GPS非対応");
    return;

  }

  navigator.geolocation.watchPosition(

    success,

    error,

    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    }

  );

  setStatus("GPS監視開始 version4");

}


// =========================
// GPS成功
// =========================

function success(position) {

  const lat =
    position.coords.latitude;

  const lng =
    position.coords.longitude;

  setStatus(
    `現在地: ${lat.toFixed(5)}, ${lng.toFixed(5)}`
  );

  processNearestSpot(lat, lng);

}


// =========================
// 最寄りスポット処理
// =========================

function processNearestSpot(
  currentLat,
  currentLng
) {
if (guidePaused) {
    console.log("探索停止中");
    return;
}

if (guideActive) {
    console.log("案内中");
    return;
}
  let nearest = null;
  let minDistance = Infinity;

  // 最短距離スポット探索
  for (const spot of spots) {

    if (
      ignoredSpots.has(spot.id)
      ||
      visitedSpots.has(spot.id)
    ) {
      continue;
    }

    const distance = getDistance(
      currentLat,
      currentLng,
      spot.lat,
      spot.lng
    );

    if (distance < minDistance) {

      minDistance = distance;
      nearest = spot;

    }

  }

  if (!nearest) return;

  // UI表示
  document.getElementById(
    "nearestSpot"
  ).textContent =

    `最寄りスポット:
     ${nearest.name}
     (${minDistance.toFixed(1)}m)`;


  // =====================
  // 接近判定
  // =====================

  if (minDistance <= triggerDistance) {

    // 新スポット接近
    if (
      !currentSpot ||
      currentSpot.id !== nearest.id
    ) {

      currentSpot = nearest;

      enterTime = Date.now();

      console.log(
        "接近開始:",
        nearest.name
      );

    }

    const stayMs =
      Date.now() - enterTime;

    document.getElementById(
      "stayTime"
    ).textContent =

      `滞在時間:
       ${(stayMs / 1000).toFixed(1)}秒`;



    // =====================
    // 滞在成立
    // =====================

    if (stayMs >= STAY_TIME) {

      const last =
        lastGuideTime[nearest.id] || 0;

      const now = Date.now();

      // クールタイム確認
      if (
        now - last >
        GUIDE_COOLDOWN
      ) {

        startGuide(nearest);

        lastGuideTime[
          nearest.id
        ] = now;

      }

    }

  }

  // =====================
  // 離脱判定
  // =====================

  else {

    if (
      currentSpot &&
      minDistance >
      LEAVE_DISTANCE
    ) {

      console.log(
        "離脱:",
        currentSpot.name
      );

      currentSpot = null;

      enterTime = null;

      document.getElementById(
        "stayTime"
      ).textContent =
        "滞在時間: 0秒";

    }

  }

}



// =========================
// 案内処理
// =========================
let currentGuideText = "";

async function startGuide(spot){

    guideActive = true;
    currentSpot = spot;

    let guideText = "";

    try{

        guideText = await createGuide(spot);

    }catch(e){

        console.error(e);

        guideText =
            "通信状態が不安定です。もう一度お試しください。";

    }

    currentGuideText = guideText;

    showGuidePanel(guideText, spot);

    playNotification();

}
// =========================
// 距離計算
// =========================

function getDistance(
  lat1,
  lng1,
  lat2,
  lng2
) {

  const R = 6371000;

  const dLat =
    toRad(lat2 - lat1);

  const dLng =
    toRad(lng2 - lng1);

  const a =

    Math.sin(dLat / 2) *
    Math.sin(dLat / 2)

    +

    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2))

    *

    Math.sin(dLng / 2) *
    Math.sin(dLng / 2);

  const c =

    2 * Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;

}


// =========================
// 度→ラジアン
// =========================

function toRad(value) {

  return value *
    Math.PI / 180;

}


// =========================
// ステータス表示
// =========================

function setStatus(text) {

  document.getElementById(
    "status"
  ).textContent = text;

}


// =========================
// GPSエラー
// =========================

function error(err) {

  console.error(err);

  alert("GPS取得失敗");

}

function speakGuide(text){

  // 前回の読み上げを停止
  speechSynthesis.cancel();

  // 音声一覧を取得
  const voices = speechSynthesis.getVoices();

  console.log(voices);

  const speech = new SpeechSynthesisUtterance(text);

  speech.lang = "ja-JP";
  speech.rate = 1.0;
  speech.pitch = 1.0;
  speech.volume = 1.0;

  // 日本語音声があれば設定
  const jaVoice = voices.find(v => v.lang.startsWith("ja"));

  if (jaVoice) {
    speech.voice = jaVoice;
  }

  speech.onerror = (e) => {
    console.log("Speech Error", e);
  };

  speech.onstart = () => {
    console.log("Speech Start");
  };

  speech.onend = () => {
    console.log("Speech End");
  };

  speechSynthesis.speak(speech);
}

function showGuidePanel(
  text,
  spot
){
  document.getElementById(
      "searchPanel"
  ).style.display="none";

  document.getElementById(
    "guidePanel"
  ).style.display = "block";

  document.getElementById(
    "spotImage"
  ).src =
    spot.imageUrl;

  document.getElementById(
    "guideTitle"
  ).textContent =
    spot.name;

  document.getElementById(
    "guideMessage"
  ).textContent =
    text;

    spotInfoOpen = true;

document
.getElementById("spotInfo")
.style.display = "block";

document
.getElementById("toggleSpotBtn")
.textContent =
    `📍 ${spot.name} ▲`;

}


document
.getElementById("goBtn")
.addEventListener("click", function () {

    if (!currentSpot) return;

    const url =
`https://www.google.com/maps/dir/?api=1&destination=${currentSpot.lat},${currentSpot.lng}`;

    visitedSpots.add(currentSpot.id);

    guidePaused = true;

    guideActive = false;

    // ガイド画面を閉じる
    document.getElementById("guidePanel").style.display = "none";

    // 探索画面のメッセージ変更
    document.getElementById("searchMessage").textContent =
        "Googleマップで目的地へ向かっています";

    // ナビ画面を表示
    document.getElementById("resumeScreen").style.display = "block";

    window.open(url, "_blank");

});


document
.getElementById("ignoreBtn")
.addEventListener(
  "click",
  function(){

    ignoredSpots.add(
      currentSpot.id
    );

    closeGuide();

  }
);


function closeGuide(){

  document.getElementById(
    "guidePanel"
  ).style.display =
    "none";

  guideActive = false;

  currentSpot = null;

  enterTime = null;

  spotInfoOpen = true;

document.getElementById(
    "searchPanel"
).style.display="block";

document.getElementById(
    "searchMessage"
).textContent=

"おすすめスポットを探しています";

}

// =========================
// AI案内生成
// =========================

async function generateGuide(spot){

    const response = await fetch(

        "https://ここにCloudflare WorkerのURL",

        {

            method:"POST",

            headers:{
                "Content-Type":"application/json"
            },

            body:JSON.stringify({

                spot:{

                    name:spot.name,

                    catchCopy:spot.catchCopy,

                    topReason:spot.topReason,

                    ownerExperience:spot.ownerExperience,

                    highlightPoints:
                        spot.highlightPoints

                }

            })

        }

    );

    const data = await response.json();

    return data.guide;

}

async function initialize() {

  setStatus("スポット読込中...");

  spots = await loadSpots();

  console.log("spots=", spots);

  console.log(spots[0]);

  if (spots.length === 0) {
    setStatus("スポットがありません");
    return;
  }

  setStatus(`${spots.length}件読み込み完了`);

}

async function createGuide(spot) {

  const response = await fetch(
    "https://fugibstqzkmzplqrpovn.supabase.co/functions/v1/guide-ai",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        spot: spot,

        userType: userType
      })
    }
  );

  if (!response.ok) {
    throw new Error("AI呼び出し失敗");
  }

  const data = await response.json();

  return data.guide;
}

const notificationAudio =
    new Audio("notification.mp3");

function playNotification(){

    console.log("通知音を再生");

    notificationAudio.currentTime = 0;

    notificationAudio.play()
    .catch(err=>{

        console.log(err);

    });

}

async function sendQuestion(){

  const response = await fetch(

    "https://fugibstqzkmzplqrpovn.supabase.co/functions/v1/chat-ai",

    {

      method:"POST",

      headers:{

        "Content-Type":"application/json",

        "Authorization":"Bearer " + SUPABASE_KEY

      },

      body:JSON.stringify({

      spot:currentSpot,

      history:chatHistory

      })

    }

  );

  if(!response.ok){

      throw new Error("チャット失敗");

  }

  const data = await response.json();

  return data.answer;

}

initialize();

document
.getElementById("resumeBtn")
.addEventListener("click", function(){

    guidePaused = false;

    guideActive = false;

    currentSpot = null;

    enterTime = null;

    // ナビ画面を閉じる
    document.getElementById("resumeScreen").style.display = "none";

    // 探索画面へ戻る
    document.getElementById("searchPanel").style.display = "block";

    document.getElementById("searchMessage").textContent =
        "おすすめスポットを探しています";

});

// =========================
// ユーザータイプ選択
// =========================

document
.querySelectorAll(".typeBtn")
.forEach(btn=>{

    btn.addEventListener(

        "click",

        function(){

            document
            .querySelectorAll(".typeBtn")
            .forEach(

                b=>b.classList.remove("selected")

            );

            this.classList.add("selected");

            userType =
                this.dataset.type;

            console.log(userType);

        }

    );

});

document
.getElementById("startGuideBtn")
.addEventListener(

    "click",

    function(){

        document
        .getElementById("startPanel")
        .style.display="none";

        startWatch();

    }

);

window.addEventListener("focus", function () {

    console.log("アプリへ戻りました");

    if (!guidePaused) return;

    console.log("探索を自動再開");

    guidePaused = false;

    guideActive = false;

    currentSpot = null;

    enterTime = null;

});

document
.getElementById("toggleSpotBtn")
.addEventListener(

    "click",

    function(){

        const spotInfo =
            document.getElementById("spotInfo");

        const btn =
            document.getElementById("toggleSpotBtn");

        if(spotInfoOpen){

            spotInfo.style.display = "none";

            btn.textContent =
                `📍 ${currentSpot.name} ▼`;

        }else{

            spotInfo.style.display = "block";

            btn.textContent =
                `📍 ${currentSpot.name} ▲`;

        }

        spotInfoOpen = !spotInfoOpen;

    }

);

document
.getElementById("startGuideBtn")
.addEventListener(

    "click",

    async function(){

        console.log("開始ボタンが押されました");

        const audio =
            new Audio("notification.mp3");

        try{

            await audio.play();

            console.log("通知音の再生成功");

            setTimeout(() => {

              audio.pause();

              audio.currentTime = 0;

            },2000);

        }catch(e){

            console.error("通知音エラー", e);

        }

        document
        .getElementById("startPanel")
        .style.display = "none";

        startWatch();

    }

);

document
.getElementById("sendBtn")
.addEventListener(

"click",

async function(){

    const question =

        document
        .getElementById("question")
        .value;

    if(question===""){

        return;

    }

    chatHistory.push({

        role:"user",

        text:question

    });

    //案内文折りたたみ処理
    const content =
        document.getElementById("spotInfo");

    content.style.display="none";

    document
    .getElementById("toggleSpotBtn")
    .textContent =
    `📍 ${currentSpot.name} ▼`;

    spotInfoOpen=false;

    const answer =
        await sendQuestion(question);

    chatHistory.push({

        role:"assistant",

        text:answer

    });

    // 履歴は最大20件（user + assistantで1往復2件）
    while(chatHistory.length > 20){

        chatHistory.shift();

    }
    

const historyDiv =
    document.getElementById("chatHistory");

historyDiv.innerHTML += `

<div class="userMessage">

👤 ${question}

</div>

<div class="aiMessage">

🤖 ${answer}

</div>

`;

const history =
    document.getElementById("chatHistory");

history.lastElementChild?.scrollIntoView({

    behavior:"smooth",

    block:"end"

});


document
.getElementById("question")
.value = "";

// 一番下までスクロール
window.scrollTo({

    top: document.body.scrollHeight,

    behavior: "smooth"

});


});

document
.getElementById("toggleDebugBtn")
.addEventListener("click",function(){

    const panel =
        document.getElementById("debugPanel");

    if(panel.style.display==="block"){

        panel.style.display="none";

        this.textContent="⚙";

    }
    else{

        panel.style.display="block";

        this.textContent="❌ 閉じる";

    }

});