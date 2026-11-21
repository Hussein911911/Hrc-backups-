/* ===========================================================================
 *  HRC — إعداد الاتصال بـ Supabase
 *  ---------------------------------------------------------------------------
 *  هذا الملف يُنشر مع الواجهة؛ Project URL وPublishable key عامّان بطبيعتهما.
 *  لا تضع هنا أبداً service_role أو sb_secret أو كلمة مرور قاعدة البيانات
 *  أو app.brc_secret. الأمان الحقيقي من RLS وسياسات المخطط.
 * =========================================================================== */
(function (root) {
  'use strict';

  root.HRCSupabaseConfig = {
    /* مشروع HRC Backup المصرّح به فقط */
    url: 'https://tkxbmopxcftxpcoczweq.supabase.co',

    /* Publishable key عام خاص بمشروع الهدف */
    publishableKey: 'sb_publishable_6Ft7Dm8XcTU351rM_sCW9Q_Ra9aF52h',

    schema: 'brc',

    /* يبقى مطفأ إلى أن يكتمل الاسترجاع وتُعرَض brc وتنجح فحوص ما بعد الاسترجاع */
    enabled: false,
    enforceAuth: true
  };
})(typeof window !== 'undefined' ? window : globalThis);
