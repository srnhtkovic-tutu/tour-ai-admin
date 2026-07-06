let map;

let marker;

const SUPABASE_URL = "https://fugibstqzkmzplqrpovn.supabase.co";
const SUPABASE_KEY = "sb_publishable_CM7-Kj4GEFY0oG2EI3t-XQ_MijxwUcZ";

const supabaseClient =
window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_KEY
);

async function loadSpots(){

    const {data,error}=await supabaseClient
        .from("spots")
        .select("*")
        .order("id");

    if(error){

        document.getElementById("status").textContent=
            error.message;

        return;

    }

    document.getElementById("status").textContent=
        `${data.length}件読み込みました ver2`;

    console.log(data);

    spots = data;

    showSpotList(spots);
}

function initializeMap(){

    map=L.map("map").setView(
        [35.2,136.1],
        10
    );

    L.tileLayer(

        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",

        {

            attribution:
            "© OpenStreetMap"

        }

    ).addTo(map);

    map.on(
        "click",
        onMapClick
    );

}

function onMapClick(e){

    setMarker(

        e.latlng.lat,

        e.latlng.lng

    );

}

function setMarker(lat,lng){

    document.getElementById("lat").value=
        lat.toFixed(8);

    document.getElementById("lng").value=
        lng.toFixed(8);

    if(marker){

        map.removeLayer(marker);

    }

    marker=L.marker(

        [lat,lng],

        {

            draggable:true

        }

    ).addTo(map);

    marker.on(

        "dragend",

        function(){

            const pos=
                marker.getLatLng();

            document.getElementById("lat").value=
                pos.lat.toFixed(8);

            document.getElementById("lng").value=
                pos.lng.toFixed(8);

        }

    );

}


initializeMap();

loadSpots();

function showSpotList(spots){

    const tbody =
        document.getElementById("spotBody");

    tbody.innerHTML="";

    for(const spot of spots){

        const row=document.createElement("tr");

        row.innerHTML=`

<td>${spot.id}</td>

<td>${spot.name}</td>

<td>${Number(spot.lat).toFixed(6)}</td>

<td>${Number(spot.lng).toFixed(6)}</td>

<td>

<button onclick="editSpot(${spot.id})">

編集

</button>

</td>

`;

        tbody.appendChild(row);

    }

}

function editSpot(id){

    currentSpot =
        spots.find(s=>s.id===id);

    if(!currentSpot){

        return;

    }

    document.getElementById("name").value =
        currentSpot.name;

    document.getElementById("lat").value =
        currentSpot.lat;

    document.getElementById("lng").value =
        currentSpot.lng;

    document.getElementById("catchCopy").value =
        currentSpot.guide_data?.catchCopy || "";

    document.getElementById("topReason").value =
        currentSpot.guide_data?.topReason || "";

    document.getElementById("ownerExperience").value =
        currentSpot.guide_data?.ownerExperience || "";

    document.getElementById("point1").value =
        currentSpot.guide_data?.highlightPoints?.[0] || "";

    document.getElementById("point2").value =
        currentSpot.guide_data?.highlightPoints?.[1] || "";

    document.getElementById("point3").value =
        currentSpot.guide_data?.highlightPoints?.[2] || "";

    map.setView(

        [currentSpot.lat,currentSpot.lng],

        16

    );

    setMarker(

        currentSpot.lat,

        currentSpot.lng

    );

    document.getElementById("imageUrl").value =
    currentSpot.image_url || "";

}

document
.getElementById("saveButton")
.addEventListener(
    "click",
    saveSpot
);

async function saveSpot() {

    // guide_data を作成
    const guideData = {

        catchCopy:
            document.getElementById("catchCopy").value,

        topReason:
            document.getElementById("topReason").value,

        ownerExperience:
            document.getElementById("ownerExperience").value,

        highlightPoints: [

            document.getElementById("point1").value,

            document.getElementById("point2").value,

            document.getElementById("point3").value

        ]

    };

    let error;

    // ==========================
    // 編集（UPDATE）
    // ==========================

    if (currentSpot) {

        ({ error } = await supabaseClient

            .from("spots")

            .update({

                name:
                    document.getElementById("name").value,

                lat: Number(
                    document.getElementById("lat").value
                ),

                lng: Number(
                    document.getElementById("lng").value
                ),

                image_url:
                    document.getElementById("imageUrl").value,

                guide_data: guideData

            })

            .eq("id", currentSpot.id)

        );

        if (error) {

            alert(error.message);
            console.error(error);
            return;

        }

        alert("更新しました！");

    }

    // ==========================
    // 新規追加（INSERT）
    // ==========================

    else {

        ({ error } = await supabaseClient

            .from("spots")

            .insert({

                name:
                    document.getElementById("name").value,

                lat: Number(
                    document.getElementById("lat").value
                ),

                lng: Number(
                    document.getElementById("lng").value
                ),

                image_url:
                    document.getElementById("imageUrl").value,

                guide_data: guideData

            })

        );

        if (error) {

            alert(error.message);
            console.error(error);
            return;

        }

        alert("追加しました！");

    }

    // 一覧を再読込
    await loadSpots();

}

function newSpot() {

    currentSpot = null;

    document.getElementById("name").value = "";
    document.getElementById("lat").value = "";
    document.getElementById("lng").value = "";

    document.getElementById("catchCopy").value = "";
    document.getElementById("topReason").value = "";
    document.getElementById("ownerExperience").value = "";

    document.getElementById("point1").value = "";
    document.getElementById("point2").value = "";
    document.getElementById("point3").value = "";

    if(marker){

    map.removeLayer(marker);

    marker=null;

    }

    map.setView(

        [35.2,136.1],

        10

    );
}

document
.getElementById("newButton")
.addEventListener(
    "click",
    newSpot
);

