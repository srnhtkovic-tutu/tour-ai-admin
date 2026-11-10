const ADMIN_SUPABASE_URL = "https://fugibstqzkmzplqrpovn.supabase.co";
const ADMIN_SUPABASE_KEY = "sb_publishable_CM7-Kj4GEFY0oG2EI3t-XQ_MijxwUcZ";
const adminSupabase = window.supabase.createClient(ADMIN_SUPABASE_URL, ADMIN_SUPABASE_KEY);

const loginForm = document.getElementById("loginForm");
const authMessage = document.getElementById("authMessage");

if (loginForm) {
  adminSupabase.auth.getSession().then(({ data }) => {
    if (data.session) window.location.replace("admin-dashboard.html");
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("loginButton");
    button.disabled = true;
    authMessage.textContent = "ログインしています...";

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const { error } = await adminSupabase.auth.signInWithPassword({ email, password });

    if (error) {
      authMessage.textContent = "ログインできませんでした。メールアドレスとパスワードをご確認ください。";
      button.disabled = false;
      return;
    }
    window.location.replace("admin-dashboard.html");
  });
}

const regionSelect = document.getElementById("regionSelect");
if (regionSelect) {
  initializeDashboard();
}

async function initializeDashboard() {
  const message = document.getElementById("dashboardMessage");
  const openButton = document.getElementById("openRegionButton");
  const { data: sessionData } = await adminSupabase.auth.getSession();

  if (!sessionData.session) {
    window.location.replace("admin-login.html");
    return;
  }

  const user = sessionData.session.user;
  const { data: profile, error: profileError } = await adminSupabase
    .from("user_profiles")
    .select("display_name,is_active,is_system_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile) {
    message.textContent = "ユーザー情報を確認できません。管理者にお問い合わせください。";
    return;
  }
  if (!profile.is_active) {
    await adminSupabase.auth.signOut();
    message.textContent = "このアカウントは無効になっています。";
    return;
  }

  document.getElementById("welcomeMessage").textContent =
    profile.display_name ? profile.display_name + " さん" : user.email;

  const { data: regions, error: regionError } = await adminSupabase
    .from("regions")
    .select("id,name")
    .eq("is_active", true)
    .order("name");

  if (regionError) {
    message.textContent = "担当地域を読み込めませんでした。";
    return;
  }

  regionSelect.replaceChildren();
  if (!regions || regions.length === 0) {
    regionSelect.add(new Option("担当地域がありません", ""));
    message.textContent = "地域の割り当てがありません。システム管理者に割り当てを依頼してください。";
    return;
  }

  regionSelect.add(new Option("地域を選択してください", ""));
  regions.forEach((region) => regionSelect.add(new Option(region.name, region.id)));
  regionSelect.addEventListener("change", () => {
    openButton.disabled = !regionSelect.value;
  });

  openButton.addEventListener("click", () => {
    const region = regions.find((item) => item.id === regionSelect.value);
    if (!region) return;
    document.getElementById("selectedRegionTitle").textContent = region.name;
    document.getElementById("regionWorkspace").classList.remove("hidden");
    message.textContent = "選択した地域: " + region.name;
  });
}

const logoutButton = document.getElementById("logoutButton");
if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    await adminSupabase.auth.signOut();
    window.location.replace("admin-login.html");
  });
}
