// ===== 請填入你的 Supabase 專案資訊 =====
// Supabase 後台 → Project Settings → API（或 Data API）
//   Project URL        → SUPABASE_URL
//   anon / publishable → SUPABASE_ANON_KEY
// 這把 anon key 本來就是公開的（會出現在瀏覽器），安全性靠資料庫的 RLS 與 RPC 權限檢查。
// ⚠️ 千萬不要把 service_role / secret key 放在這裡！
window.DOCK_CONFIG = {
  SUPABASE_URL: 'https://mqlmnfaakxmnzbxxrgwt.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_AMOJlgx8nYseISDvhuYRbw_04A1oK5-',
  ALLOW_PASSWORD: true,     // 允許密碼登入
  ALLOW_EMAIL_CODE: true,   // 允許 Email 驗證碼登入
  REMEMBER_DAYS: 30,        // 只是畫面文字；實際有效期由 Supabase Auth 設定決定
  PWD_MIN_LEN: 8
};
