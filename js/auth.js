/**
 * 碼頭排程系統 - 登入與 authRun()（取代 Auth.gs + AuthUI.html）
 *
 * 頁面在 <head> 先設定 window.DOCK_PAGE = 'index' | 'dashboard' | 'gatekeeper' | 'admin'，
 * 再依序載入 config.js → supabase-js → auth.js → api.js。
 *
 * authRun() 用法與原本完全相同：
 *   authRun().withSuccessHandler(fn).withFailureHandler(fn).功能名稱(參數...)
 * 只是實際執行的是 api.js 的 DockApi[功能名稱]，而不是 google.script.run。
 */
(function () {
  const CFG = window.DOCK_CONFIG || {};
  const PAGE = window.DOCK_PAGE || '';
  const PAGE_NAMES = { index: '客服預約', dashboard: '現場動態看板', gatekeeper: '警衛室管制台', admin: '主管管理後台' };

  // 與原本 Auth.gs 相同的權限表（真正的保護在資料庫 RLS/RPC，這裡只是讓畫面提早提示）
  const PAGE_ROLES = {
    index: ['cs'],
    dashboard: ['cs', 'warehouse', 'guard', 'viewer'],
    gatekeeper: ['guard'],
    admin: []
  };
  const API_ROLES = {
    getWebAppUrl: ['*'], getDataVersion: ['*'], getDashboardDataByDate: ['*'],
    updateVehicleGateStatus: ['warehouse', 'guard'],
    getIndexInitData: ['cs'], searchBookingForEdit: ['cs'], cancelBookingFromEdit: ['cs'],
    processBookingSubmission: ['cs'], updateBookingSubmission: ['cs'],
    getGatekeeperDashboardData: ['guard'],
    getAdminDashboardData: [], updateAdminBooking: [], getLockRules: [], addLockRule: [],
    deleteLockRule: [], getDutySchedule: [], saveDutyScheduleRange: [], saveDutySchedule: [], getRangeReport: []
  };

  // ---------- 「記住此裝置」：勾選存 localStorage（關閉瀏覽器仍登入），不勾存 sessionStorage ----------
  const REMEMBER_KEY = 'dockAuthRemember';
  const getRemember = () => { try { return localStorage.getItem(REMEMBER_KEY) === '1'; } catch (e) { return false; } };
  const setRemember = (on) => { try { localStorage.setItem(REMEMBER_KEY, on ? '1' : '0'); } catch (e) {} };
  const storage = {
    getItem(k) { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch (e) { return null; } },
    setItem(k, v) {
      try {
        if (getRemember()) { localStorage.setItem(k, v); sessionStorage.removeItem(k); }
        else { sessionStorage.setItem(k, v); localStorage.removeItem(k); }
      } catch (e) {}
    },
    removeItem(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {} }
  };

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { storage: storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'dockAuth_sb' }
  });
  window.dockSb = sb;

  let me = null;          // { email, name, roles, hasPassword }
  let pages = [];
  let ready = false;      // 已確認登入且有此頁權限
  let pending = [];

  const hasRole = (allowed) => !!me && (me.roles.includes('admin') || allowed.includes('*') || allowed.some(r => me.roles.includes(r)));

  // ---------- authRun：與 google.script.run 相同的寫法 ----------
  window.authRun = function () {
    let onOk = null, onFail = null, userObj;
    const proxy = new Proxy({}, {
      get(_, prop) {
        if (prop === 'withSuccessHandler') return f => { onOk = f; return proxy; };
        if (prop === 'withFailureHandler') return f => { onFail = f; return proxy; };
        if (prop === 'withUserObject') return o => { userObj = o; return proxy; };
        return function () { send({ name: String(prop), args: Array.prototype.slice.call(arguments), onOk, onFail, userObj }); };
      }
    });
    return proxy;
  };

  function send(call) {
    if (!ready) { enqueue(call); return; }
    const fn = window.DockApi && window.DockApi[call.name];
    if (!fn || !Object.prototype.hasOwnProperty.call(API_ROLES, call.name)) {
      alert('⛔ 未開放的功能（' + call.name + '）');
      return;
    }
    if (!hasRole(API_ROLES[call.name])) { alert('⛔ 您的帳號沒有使用此功能的權限'); return; }

    Promise.resolve()
      .then(() => fn.apply(null, call.args))
      .then(res => { if (call.onOk) call.onOk(res, call.userObj); })
      .catch(err => {
        const msg = String((err && err.message) || err);
        if (/AUTH_REQUIRED|JWT expired|invalid JWT|401/i.test(msg) || err.code === 'PGRST301') {
          ready = false;
          enqueue(call);
          showLogin('登入已過期，請重新登入');
          return;
        }
        if (msg.indexOf('AUTH_FORBIDDEN') >= 0) { alert('⛔ ' + msg.replace(/^.*AUTH_FORBIDDEN:\s*/, '')); return; }
        if (call.onFail) call.onFail(err, call.userObj); else { console.error(err); alert('❌ ' + msg); }
      });
  }

  function enqueue(call) {
    const key = call.name + '|' + JSON.stringify(call.args);
    pending = pending.filter(c => c.key !== key);
    call.key = key;
    pending.push(call);
  }
  function flushPending() { const list = pending; pending = []; list.forEach(send); }

  // ---------- 讀取登入者資料 ----------
  async function loadProfile() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { ok: false, message: '' };
    const email = String(session.user.email || '').toLowerCase();
    const { data, error } = await sb.from('app_users').select('email,name,roles,active').eq('email', email).maybeSingle();
    if (error) return { ok: false, message: '讀取帳號資料失敗：' + error.message };
    if (!data || !data.active) {
      await sb.auth.signOut();
      return { ok: false, message: '此帳號未啟用或尚未被授權，請聯絡主管' };
    }
    me = {
      email: email,
      name: data.name || email,
      roles: (data.roles || []).map(r => String(r).toLowerCase()),
      hasPassword: !!(session.user.user_metadata && session.user.user_metadata.has_password)
    };
    pages = Object.keys(PAGE_ROLES).filter(p => hasRole(PAGE_ROLES[p]));
    return { ok: true };
  }

  async function afterLogin() {
    const r = await loadProfile();
    if (!r.ok) { showLogin(r.message); return; }
    if (PAGE && pages.indexOf(PAGE) < 0) { pending = []; showForbidden(); return; }
    ready = true;
    hideOverlay();
    showBadge();
    flushPending();
  }

  // ---------- 登入畫面 ----------
  const css = `
  .dock-auth-overlay { position: fixed; inset: 0; z-index: 20000; background: rgba(15,23,42,.72); display: none; align-items: center; justify-content: center; padding: 16px; font-family: "Microsoft JhengHei", sans-serif; }
  .dock-auth-overlay.show { display: flex; }
  .dock-auth-box { background: #fff; color: #222; width: 100%; max-width: 380px; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.35); padding: 24px; }
  .dock-auth-box h3 { margin: 0 0 4px; font-size: 20px; }
  .dock-auth-sub { color: #666; font-size: 13px; margin-bottom: 16px; }
  .dock-auth-tabs { display: flex; gap: 6px; margin-bottom: 14px; }
  .dock-auth-tabs button { flex: 1; padding: 8px; border: 1px solid #ccd; background: #f4f6fa; border-radius: 6px; cursor: pointer; font-size: 14px; color: #222; }
  .dock-auth-tabs button.active { background: #0d6efd; color: #fff; border-color: #0d6efd; font-weight: bold; }
  .dock-auth-box label { display: block; font-size: 13px; margin: 10px 0 4px; color: #444; }
  .dock-auth-box input[type=email], .dock-auth-box input[type=password], .dock-auth-box input[type=text] { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #bbb; border-radius: 6px; font-size: 15px; color: #222; background: #fff; }
  .dock-auth-row { display: flex; gap: 8px; }
  .dock-auth-row input { flex: 1; }
  .dock-auth-btn { width: 100%; margin-top: 14px; padding: 10px; border: 0; border-radius: 6px; background: #0d6efd; color: #fff; font-size: 15px; font-weight: bold; cursor: pointer; }
  .dock-auth-btn.secondary { background: #6c757d; width: auto; margin-top: 0; padding: 9px 12px; font-weight: normal; white-space: nowrap; }
  .dock-auth-btn.link { background: none; color: #0d6efd; font-weight: normal; padding: 6px; margin-top: 6px; }
  .dock-auth-btn:disabled { opacity: .6; cursor: wait; }
  .dock-auth-remember { display: flex !important; align-items: center; gap: 6px; font-size: 13px; margin-top: 12px; color: #444; }
  .dock-auth-msg { font-size: 13px; margin-top: 12px; min-height: 18px; }
  .dock-auth-msg.err { color: #c62828; }
  .dock-auth-msg.ok { color: #2e7d32; }
  .dock-auth-badge { position: fixed; left: 8px; bottom: 8px; z-index: 19000; font: 12px "Microsoft JhengHei", sans-serif; background: rgba(255,255,255,.92); border: 1px solid #ccc; border-radius: 16px; padding: 4px 10px; box-shadow: 0 2px 6px rgba(0,0,0,.15); display: none; color: #333; }
  .dock-auth-badge.show { display: block; }
  .dock-auth-badge a { color: #0d6efd; cursor: pointer; margin-left: 8px; text-decoration: none; }`;

  let overlay = null, mode = CFG.ALLOW_PASSWORD !== false ? 'pwd' : 'code';
  const el = id => document.getElementById(id);

  function buildOverlay() {
    if (overlay) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    overlay = document.createElement('div');
    overlay.className = 'dock-auth-overlay';
    overlay.innerHTML =
      '<div class="dock-auth-box">' +
        '<h3>🔐 碼頭排程系統登入</h3>' +
        '<div class="dock-auth-sub" id="dockAuthSub"></div>' +
        '<div id="dockAuthLoginPane">' +
          '<div class="dock-auth-tabs" id="dockAuthTabs">' +
            (CFG.ALLOW_PASSWORD !== false ? '<button type="button" data-mode="pwd">密碼登入</button>' : '') +
            (CFG.ALLOW_EMAIL_CODE !== false ? '<button type="button" data-mode="code">Email 驗證碼</button>' : '') +
          '</div>' +
          '<label>Email</label><input type="email" id="dockAuthEmail" autocomplete="username">' +
          '<div id="dockAuthPwdPane"><label>密碼</label><input type="password" id="dockAuthPwd" autocomplete="current-password"></div>' +
          '<div id="dockAuthCodePane"><label>驗證碼</label><div class="dock-auth-row">' +
            '<input type="text" id="dockAuthCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 位數字">' +
            '<button type="button" class="dock-auth-btn secondary" id="dockAuthSend">寄送驗證碼</button></div></div>' +
          '<label class="dock-auth-remember"><input type="checkbox" id="dockAuthRemember"> 記住此裝置 ' + (CFG.REMEMBER_DAYS || 30) + ' 天（公用電腦請勿勾選）</label>' +
          '<button type="button" class="dock-auth-btn" id="dockAuthSubmit">登入</button>' +
        '</div>' +
        '<div id="dockAuthPwdChangePane" style="display:none">' +
          '<label>新密碼（至少 ' + (CFG.PWD_MIN_LEN || 8) + ' 字元，需含英文與數字）</label><input type="password" id="dockAuthNewPwd" autocomplete="new-password">' +
          '<label>再輸入一次</label><input type="password" id="dockAuthNewPwd2" autocomplete="new-password">' +
          '<button type="button" class="dock-auth-btn" id="dockAuthPwdSave">儲存密碼</button>' +
          '<button type="button" class="dock-auth-btn link" id="dockAuthPwdCancel">取消</button>' +
        '</div>' +
        '<div id="dockAuthForbiddenPane" style="display:none">' +
          '<button type="button" class="dock-auth-btn" id="dockAuthSwitch">切換帳號</button>' +
        '</div>' +
        '<div class="dock-auth-msg" id="dockAuthMsg"></div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.querySelectorAll('#dockAuthTabs button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    el('dockAuthSend').addEventListener('click', requestCode);
    el('dockAuthSubmit').addEventListener('click', submitLogin);
    el('dockAuthPwd').addEventListener('keydown', e => { if (e.key === 'Enter') submitLogin(); });
    el('dockAuthCode').addEventListener('keydown', e => { if (e.key === 'Enter') submitLogin(); });
    el('dockAuthPwdSave').addEventListener('click', savePassword);
    el('dockAuthPwdCancel').addEventListener('click', () => { if (ready) hideOverlay(); });
    el('dockAuthSwitch').addEventListener('click', logout);
    el('dockAuthRemember').checked = getRemember();
    setMode(mode);
  }

  function setMode(m) {
    mode = m;
    overlay.querySelectorAll('#dockAuthTabs button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    el('dockAuthPwdPane').style.display = m === 'pwd' ? '' : 'none';
    el('dockAuthCodePane').style.display = m === 'code' ? '' : 'none';
    setMsg('');
  }
  function setMsg(text, kind) { const m = el('dockAuthMsg'); m.textContent = text || ''; m.className = 'dock-auth-msg' + (kind ? ' ' + kind : ''); }
  function showPane(name) {
    el('dockAuthLoginPane').style.display = name === 'login' ? '' : 'none';
    el('dockAuthPwdChangePane').style.display = name === 'pwd' ? '' : 'none';
    el('dockAuthForbiddenPane').style.display = name === 'forbidden' ? '' : 'none';
  }
  function showLogin(message) {
    whenReady(() => {
      buildOverlay(); hideBadge(); showPane('login');
      el('dockAuthSub').textContent = '請登入以使用「' + (PAGE_NAMES[PAGE] || '本系統') + '」';
      setMsg(message || '', message ? 'err' : '');
      overlay.classList.add('show');
      setTimeout(() => (el('dockAuthEmail').value ? (mode === 'pwd' ? el('dockAuthPwd') : el('dockAuthCode')) : el('dockAuthEmail')).focus(), 50);
    });
  }
  function showForbidden() {
    whenReady(() => {
      buildOverlay(); showPane('forbidden');
      el('dockAuthSub').textContent = '您目前登入的帳號（' + me.name + '）沒有「' + (PAGE_NAMES[PAGE] || '此頁面') + '」的使用權限，請聯絡主管開通，或切換帳號。';
      setMsg('');
      overlay.classList.add('show');
    });
  }
  function hideOverlay() { if (overlay) overlay.classList.remove('show'); }
  function busy(btn, on, text) { btn.disabled = on; if (text) btn.textContent = text; }

  async function requestCode() {
    const email = el('dockAuthEmail').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg('請輸入正確的 Email', 'err'); return; }
    const btn = el('dockAuthSend');
    busy(btn, true, '寄送中…');
    const { error } = await sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } });
    busy(btn, false, '重新寄送');
    const generic = '若此 Email 已在系統中啟用，驗證碼已寄出，請到信箱查看。';
    if (!error) { setMsg(generic, 'ok'); el('dockAuthCode').focus(); return; }
    // 未授權的 Email 會被資料庫 gate_signup 擋下；為避免被拿來猜帳號，回覆同樣訊息
    if (/Database error|EMAIL_NOT_ALLOWED|Signups not allowed/i.test(error.message)) { setMsg(generic, 'ok'); return; }
    if (/rate limit|seconds/i.test(error.message)) { setMsg('驗證碼剛寄出，請稍候再重新寄送', 'err'); return; }
    setMsg('寄送失敗：' + error.message, 'err');
  }

  async function submitLogin() {
    const email = el('dockAuthEmail').value.trim().toLowerCase();
    if (!email) { setMsg('請輸入 Email', 'err'); return; }
    setRemember(el('dockAuthRemember').checked);
    const btn = el('dockAuthSubmit');
    let result;
    if (mode === 'pwd') {
      const pwd = el('dockAuthPwd').value;
      if (!pwd) { setMsg('請輸入密碼', 'err'); return; }
      busy(btn, true, '登入中…');
      result = await sb.auth.signInWithPassword({ email: email, password: pwd });
      if (result.error) { busy(btn, false, '登入'); setMsg('帳號或密碼錯誤（若尚未設定密碼，請改用 Email 驗證碼登入）', 'err'); return; }
    } else {
      const code = el('dockAuthCode').value.replace(/\D/g, '');
      if (!code) { setMsg('請輸入驗證碼', 'err'); return; }
      busy(btn, true, '登入中…');
      result = await sb.auth.verifyOtp({ email: email, token: code, type: 'email' });
      if (result.error) { busy(btn, false, '登入'); setMsg('驗證碼錯誤或已過期', 'err'); return; }
    }
    busy(btn, false, '登入');
    el('dockAuthPwd').value = ''; el('dockAuthCode').value = '';
    try { await sb.rpc('touch_login'); } catch (e) {}
    await afterLogin();
    if (ready && CFG.ALLOW_PASSWORD !== false && me && !me.hasPassword) {
      setTimeout(() => {
        if (confirm('您尚未設定密碼。要現在設定嗎？\n（設定後下次可直接用密碼登入，不必再收驗證碼）')) openPasswordChange();
      }, 300);
    }
  }

  function openPasswordChange() {
    buildOverlay(); showPane('pwd');
    el('dockAuthSub').textContent = (me.hasPassword ? '變更' : '設定') + '密碼：' + me.email;
    el('dockAuthNewPwd').value = ''; el('dockAuthNewPwd2').value = '';
    setMsg('');
    overlay.classList.add('show');
    setTimeout(() => el('dockAuthNewPwd').focus(), 50);
  }

  async function savePassword() {
    const p1 = el('dockAuthNewPwd').value, p2 = el('dockAuthNewPwd2').value;
    const min = CFG.PWD_MIN_LEN || 8;
    if (p1 !== p2) { setMsg('兩次輸入的密碼不一致', 'err'); return; }
    if (p1.length < min) { setMsg('密碼至少需要 ' + min + ' 個字元', 'err'); return; }
    if (!/[A-Za-z]/.test(p1) || !/\d/.test(p1)) { setMsg('密碼需同時包含英文字母與數字', 'err'); return; }
    const btn = el('dockAuthPwdSave');
    busy(btn, true, '儲存中…');
    const { error } = await sb.auth.updateUser({ password: p1, data: { has_password: true } });
    busy(btn, false, '儲存密碼');
    if (error) { setMsg('儲存失敗：' + error.message, 'err'); return; }
    try { await sb.auth.signOut({ scope: 'others' }); } catch (e) {}   // 其他裝置的登入失效（同原本行為）
    me.hasPassword = true;
    alert('✅ 密碼已設定完成');
    hideOverlay();
    showBadge();
  }

  async function logout() {
    const email = me ? me.email : '';
    ready = false; me = null;
    await sb.auth.signOut();
    showLogin();
    if (email) el('dockAuthEmail').value = email;
  }

  // ---------- 左下角登入者標籤 ----------
  let badge = null;
  function showBadge() {
    whenReady(() => {
      if (!overlay) buildOverlay();
      if (!badge) { badge = document.createElement('div'); badge.className = 'dock-auth-badge'; document.body.appendChild(badge); }
      badge.innerHTML = '';
      const name = document.createElement('span');
      name.textContent = '👤 ' + me.name;
      badge.appendChild(name);
      if (CFG.ALLOW_PASSWORD !== false) {
        const a = document.createElement('a');
        a.textContent = me.hasPassword ? '變更密碼' : '設定密碼';
        a.onclick = openPasswordChange;
        badge.appendChild(a);
      }
      const out = document.createElement('a');
      out.textContent = '登出';
      out.onclick = () => { if (confirm('確定要登出嗎？')) logout(); };
      badge.appendChild(out);
      badge.classList.add('show');
    });
  }
  function hideBadge() { if (badge) badge.classList.remove('show'); }
  function whenReady(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }

  // 其他分頁登出 / token 失效
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && ready) { ready = false; me = null; showLogin(); }
  });

  // ---------- 開頁時確認登入狀態 ----------
  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.indexOf('YOUR-PROJECT') >= 0) {
    whenReady(() => alert('⚠️ 尚未設定 js/config.js 的 SUPABASE_URL / SUPABASE_ANON_KEY'));
  }
  afterLogin().catch(err => showLogin('連線失敗：' + (err.message || err)));
})();
