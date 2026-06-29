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

    showSpotList(data);
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

    alert(id + " を編集します");

}