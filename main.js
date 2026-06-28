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

}

loadSpots();