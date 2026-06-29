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
        `${data.length}件読み込みました`;

    console.log(data);

    spots = data;

    showSpotList(spots);
}

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

}

document
.getElementById("saveButton")
.addEventListener(
    "click",
    saveSpot
);

async function saveSpot(){

    if(!currentSpot){

        const guideData={

            catchCopy:
            document.getElementById("catchCopy").value,

            topReason:
            document.getElementById("topReason").value,

            ownerExperience:
            document.getElementById("ownerExperience").value,

            highlightPoints:[

                document.getElementById("point1").value,

                document.getElementById("point2").value,

                document.getElementById("point3").value
            ]

        };

        const {error}=await supabaseClient

            .from("spots")

            .update({

            name:
            document.getElementById("name").value,

            lat:Number(
                document.getElementById("lat").value
            ),

            lng:Number(
                document.getElementById("lng").value
            ),

            guide_data:guideData

        })

        .eq("id",currentSpot.id);

        if(error){

            alert(error.message);

            console.error(error);

            return;

        }
        alert("保存しました！");

        loadSpots();

    }else{
        const {error}=await supabaseClient

            .from("spots")

            .insert({

            name:
                document.getElementById("name").value,

            lat:Number(
                document.getElementById("lat").value
            ),

            lng:Number(
                document.getElementById("lng").value
            ),

            guide_data:guideData

            });

        await loadSpots();

        alert("追加しました！");
    }

}

document
.getElementById("newButton")
.addEventListener(
    "click",
    newSpot
);

