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
  if (profile.is_system_admin) document.getElementById("adminSettingsLink")?.classList.remove("hidden");

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
    window.location.href = "admin-spots.html?region=" + encodeURIComponent(region.id);
  });
}

const logoutButton = document.getElementById("logoutButton");
if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    await adminSupabase.auth.signOut();
    window.location.replace("admin-login.html");
  });
}


let managementUserId = null;
if (document.getElementById("usersList")) initializeManagement();

async function initializeManagement() {
  const message = document.getElementById("managementMessage");
  const { data: sessionData } = await adminSupabase.auth.getSession();
  if (!sessionData.session) { window.location.replace("admin-login.html"); return; }
  managementUserId = sessionData.session.user.id;
  const { data: profile, error } = await adminSupabase.from("user_profiles")
    .select("is_active,is_system_admin").eq("id", managementUserId).maybeSingle();
  if (error || !profile || !profile.is_active || !profile.is_system_admin) {
    message.textContent = "この画面を利用する権限がありません。"; return;
  }
  message.textContent = "システム管理者としてログインしています。";
  await refreshManagement();
  document.getElementById("regionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button"); button.disabled = true;
    const name = document.getElementById("regionName").value.trim();
    const slug = document.getElementById("regionSlug").value.trim();
    const { error } = await adminSupabase.from("regions").insert({ name, slug });
    button.disabled = false;
    if (error) { message.textContent = "地域を追加できませんでした。地域IDの重複などをご確認ください。"; return; }
    event.currentTarget.reset(); message.textContent = "地域を追加しました。"; await refreshManagement();
  });
}

async function refreshManagement() {
  const message = document.getElementById("managementMessage");
  const [rr, ur, ar] = await Promise.all([
    adminSupabase.from("regions").select("id,name,slug,is_active").order("name"),
    adminSupabase.from("user_profiles").select("id,email,display_name,is_active,is_system_admin").order("created_at"),
    adminSupabase.from("user_regions").select("user_id,region_id")
  ]);
  if (rr.error || ur.error || ar.error) { message.textContent = "管理情報を読み込めませんでした。権限設定をご確認ください。"; return; }
  const regions=rr.data||[], users=ur.data||[], assignments=ar.data||[];
  const regionsList=document.getElementById("regionsList"); regionsList.replaceChildren();
  regions.forEach((region)=>{
    const row=document.createElement("div"); row.className="management-row";
    const info=document.createElement("div"); const title=document.createElement("strong"); title.textContent=region.name;
    const sub=document.createElement("div"); sub.className="status-text"; sub.textContent=region.slug+" ・ "+(region.is_active?"有効":"無効"); info.append(title,sub);
    const toggle=document.createElement("button"); toggle.className="secondary-button"; toggle.textContent=region.is_active?"無効にする":"再有効化";
    toggle.addEventListener("click",async()=>{toggle.disabled=true;const {error}=await adminSupabase.from("regions").update({is_active:!region.is_active,updated_at:new Date().toISOString()}).eq("id",region.id);if(error)message.textContent="地域の状態を変更できませんでした。";else{message.textContent="地域の状態を更新しました。";await refreshManagement();}});
    row.append(info,toggle); regionsList.append(row);
  });
  const usersList=document.getElementById("usersList"); usersList.replaceChildren();
  users.forEach((person)=>{
    const row=document.createElement("div"); row.className="management-row user-row";
    const info=document.createElement("div"); const title=document.createElement("strong"); title.textContent=person.display_name||person.email||person.id;
    const sub=document.createElement("div"); sub.className="status-text"; sub.textContent=(person.email||"")+" ・ "+(person.is_system_admin?"システム管理者":"一般ユーザー")+" ・ "+(person.is_active?"有効":"無効"); info.append(title,sub);
    const actions=document.createElement("div");
    if(person.id!==managementUserId){const toggle=document.createElement("button");toggle.className="secondary-button";toggle.textContent=person.is_active?"無効にする":"有効にする";toggle.addEventListener("click",async()=>{toggle.disabled=true;const {error}=await adminSupabase.from("user_profiles").update({is_active:!person.is_active,updated_at:new Date().toISOString()}).eq("id",person.id);if(error)message.textContent=error.message.includes("最後の有効な")?error.message:"ユーザー状態を変更できませんでした。";else message.textContent="ユーザー状態を更新しました。";await refreshManagement();});actions.append(toggle);}
    else {const self=document.createElement("span");self.className="status-text";self.textContent="現在ログイン中";actions.append(self);}
    if(person.id!==managementUserId){
      const role=document.createElement("button");role.className="secondary-button";
      role.textContent=person.is_system_admin?"管理者権限を解除":"管理者にする";
      role.addEventListener("click",async()=>{
        if(!window.confirm(person.is_system_admin?"このユーザーのシステム管理者権限を解除しますか？":"このユーザーにシステム管理者権限を付与しますか？"))return;
        role.disabled=true;
        const {error}=await adminSupabase.from("user_profiles").update({is_system_admin:!person.is_system_admin,updated_at:new Date().toISOString()}).eq("id",person.id);
        if(error)message.textContent=error.message.includes("最後の有効な")?error.message:"管理者権限を変更できませんでした。";
        else message.textContent="管理者権限を更新しました。";
        await refreshManagement();
      });
      actions.append(role);
    }
    const assignment=document.createElement("div");assignment.className="assignment-controls";
    const select=document.createElement("select");select.setAttribute("aria-label","割り当てる地域");select.add(new Option("地域を選択",""));
    regions.filter(r=>r.is_active).forEach(r=>select.add(new Option(r.name,r.id)));
    const assign=document.createElement("button");assign.textContent="割り当て";assign.addEventListener("click",async()=>{if(!select.value)return;assign.disabled=true;const {error}=await adminSupabase.from("user_regions").insert({user_id:person.id,region_id:select.value});if(error&&error.code!=="23505")message.textContent="地域を割り当てられませんでした。";else message.textContent="地域を割り当てました。";await refreshManagement();});assignment.append(select,assign);
    const assigned=document.createElement("div");assigned.className="assigned-regions";
    assignments.filter(a=>a.user_id===person.id).forEach(a=>{const region=regions.find(r=>r.id===a.region_id);if(!region)return;const remove=document.createElement("button");remove.className="secondary-button";remove.textContent=region.name+" ×";remove.title="地域割り当てを解除";remove.addEventListener("click",async()=>{remove.disabled=true;const {error}=await adminSupabase.from("user_regions").delete().eq("user_id",person.id).eq("region_id",region.id);if(error)message.textContent="地域割り当てを解除できませんでした。";else message.textContent="地域割り当てを解除しました。";await refreshManagement();});assigned.append(remove);});
    row.append(info,actions,assignment,assigned);usersList.append(row);
  });
}


// Password recovery request from the login page.
const resetPasswordButton = document.getElementById("resetPasswordButton");
if (resetPasswordButton) {
  resetPasswordButton.addEventListener("click", async () => {
    const email = document.getElementById("email").value.trim();
    const message = document.getElementById("authMessage");
    if (!email) {
      message.textContent = "先にメールアドレスを入力してください。";
      document.getElementById("email").focus();
      return;
    }

    resetPasswordButton.disabled = true;
    message.textContent = "再設定メールを送信しています...";
    const redirectTo = new URL("admin-reset-password.html", window.location.href).toString();
    const { error } = await adminSupabase.auth.resetPasswordForEmail(email, { redirectTo });

    if (error) {
      message.textContent = "メールを送信できませんでした。時間をおいて再度お試しください。";
      resetPasswordButton.disabled = false;
      return;
    }

    message.textContent = "該当するアカウントがある場合、パスワード再設定メールを送信しました。メールをご確認ください。";
    resetPasswordButton.disabled = false;
  });
}

// Password update after the user opens the recovery link.
const resetPasswordForm = document.getElementById("resetPasswordForm");
if (resetPasswordForm) {
  const message = document.getElementById("resetPasswordMessage");
  const updateButton = document.getElementById("updatePasswordButton");

  adminSupabase.auth.getSession().then(({ data, error }) => {
    if (error || !data.session) {
      message.textContent = "再設定リンクが無効か、有効期限が切れています。ログイン画面から再度メールを送信してください。";
      updateButton.disabled = true;
      return;
    }
    message.textContent = "新しいパスワードを入力してください。";
    updateButton.disabled = false;
  });

  resetPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.getElementById("newPassword").value;
    const confirmation = document.getElementById("confirmPassword").value;

    if (password.length < 8) {
      message.textContent = "パスワードは8文字以上で入力してください。";
      return;
    }
    if (password !== confirmation) {
      message.textContent = "2つのパスワードが一致していません。";
      return;
    }

    updateButton.disabled = true;
    message.textContent = "パスワードを更新しています...";
    const { data: sessionData, error: sessionError } = await adminSupabase.auth.getSession();
    if (sessionError || !sessionData.session) {
      message.textContent = "再設定セッションを確認できません。ログイン画面から再度メールを送信してください。";
      updateButton.disabled = false;
      return;
    }

    const { error } = await adminSupabase.auth.updateUser({ password });
    if (error) {
      message.textContent = "パスワードを更新できませんでした。入力内容をご確認ください。";
      updateButton.disabled = false;
      return;
    }

    await adminSupabase.auth.signOut();
    window.location.replace("admin-login.html?password-updated=1");
  });
}

if (loginForm && new URLSearchParams(window.location.search).get("password-updated") === "1") {
  authMessage.textContent = "パスワードを更新しました。新しいパスワードでログインしてください。";
}
