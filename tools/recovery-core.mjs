#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   HRC — نواة الاسترجاع المحلي (بلا psql، بلا لصق، بلا إنترنت)

   ⚠️ لماذا هذا الملف موجود؟

   المالك يحتاج عند الطوارئ أن يعيد بناء قاعدة كاملة من ملف `HRC-FULL.sql`
   الذي ينزّله من `restore.html`. وكان الطريق الوحيد أمامه:
     • لصق ٢٠٥٠٠ سطر في محرّر Supabase ← المحرّر يقصّ عند ~٢٠٠٠ سطر
       ويقول «Success» رغم النقص. أخطر نتيجة ممكنة.
     • أو `psql` من الطرفية ← المالك رفض الطرفية صراحةً.

   فهذه نواة تُنفّذ الملف كما هو، بترتيب، وتتحقق من الأعداد بعده. تُستعمل من:
     • `tools/recovery-server.mjs`  ← الخادم المحلي لصفحة الاسترجاع
     • `tools/recovery-cli.mjs`     ← سطر أوامر لمن يريد

   ═══ الأمان المتعمَّد ═══
   ١) لا `BEGIN` شامل: الملف نفسه مقسّم إلى مراحل معاملات مستقلة، وكل
      مرحلة تُثبَّت وحدها — تماماً كما صُمّم `assets/js/full-dump.js`.
   ٢) لا نُنفّذ على قاعدة موجودة فيها بيانات بلا كلمة تأكيد صريحة، لأن
      الملف يبدأ بـ`TRUNCATE` — أي **يمسح** كل ما في brc.
   ٣) لا يُنزّل ولا يُرسل شي إلى أي جهة: اتصال مباشر بالقاعدة التي يحدّدها
      المالك، من جهازه.

   ═══ لماذا التقسيم هنا وليس في المتصفح؟ ═══
   المتصفح أصلاً يخرج الملف مقسّماً بعلامات مراحل واضحة (انظر
   `full-dump.js`: كل مرحلة معاملة مستقلة). هنا نُعيد استعمال **نفس** نواة
   التقسيم المستعملة في البناء (`tools/sql-split-core.mjs`) — لا نسخة ثانية
   من المنطق تنحرف بصمت.
   ═══════════════════════════════════════════════════════════════════════════ */
import { splitStatements } from './sql-split-core.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* يقفل منفّذ هذه المهمة على مشروع الاسترجاع المصرّح به فقط.
   لا تُمرّر كلمة المرور أو رابط الاتصال إلى السجلات أو التقارير. */
export const EXPECTED_PROJECT_REF = 'tkxbmopxcftxpcoczweq';
export const EXPECTED_DATABASE_HOST = `db.${EXPECTED_PROJECT_REF}.supabase.co`;

export function assertTargetConnectionString(connectionString) {
  let u;
  try { u = new URL(connectionString); }
  catch { throw new Error('رابط اتصال غير صالح.'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) {
    throw new Error('يُسمح فقط برابط PostgreSQL للمشروع المحدد.');
  }
  if (u.hostname.toLowerCase() !== EXPECTED_DATABASE_HOST) {
    throw new Error('تم رفض الاتصال: الرابط لا يطابق مشروع الاسترجاع المصرّح به.');
  }
  if ((u.port || '5432') !== '5432' || decodeURIComponent(u.pathname || '') !== '/postgres') {
    throw new Error('يُسمح فقط باتصال قاعدة postgres المباشر على المنفذ 5432 للمشروع المحدد.');
  }
  return true;
}

/* ═══ جرد الإنتاج المرجعي ═══════════════════════════════════════════════════
   ⚠️ أهم ما في هذه الأداة أنها **لا تكذب**.

   عند كتابة هذا الملف (2026-11-17) قِيس الفرق بين ما يبنيه
   `docs/schema.sql` وبين قاعدة الإنتاج الحيّة، فظهر:
     • ٣ جداول في الإنتاج غير موجودة في ملف الهيكل.
     • ٩ دوال في الإنتاج غير موجودة فيه (منها `security_audit` و
       `recovery_export_full` و`card_lookup_guard`).
     • فهرس فريد على `job_attempts.chance_code` غير موجود فيه.
   أي أن **الاسترجاع من الملف وحده يعيد قاعدة تعمل — لكنها ليست نسخة
   مطابقة للإنتاج.** وهذا يجب أن يُقال صراحةً، لا أن يُخفى تحت «نجح».

   لذلك بعد كل استرجاع نقارن ونعرض الفرق. المصدر `docs/schema-live-inventory.json`
   المأخوذ من القاعدة الحيّة. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let INVENTORY = null;
try { INVENTORY = JSON.parse(readFileSync(resolve(ROOT, 'docs/schema-live-inventory.json'), 'utf8')); }
catch (e) { INVENTORY = null; }

export const KNOWN_GAPS = {
  /* ما يبقى خارج الاسترجاع بقصد، مع السبب — يُعرض للمستخدم لا يُخفى. */
  tables: {
    applicants_no_backup_20261011: 'لقطة صيانة يدوية قديمة (احتياطي الحذف)',
    jobs_image_url_rollback_20261112: 'لقطة تراجع يدوية قبل نقل الصور'
  },
  funcs: {
    security_audit: 'تقرير تدقيق أمني للقراءة فقط، لا تعتمد عليه واجهة',
    /* هذه الثلاثة من الجيل الأول للمشغّلات. الإنتاج يستعمل `trg_make_attempts`
       و`trg_defaults` بدلاً منها، وهي موجودة لأن الإنتاج لم يحذف القديم.
       إنشاؤها في قاعدة جديدة يعني مشغّلين مزدوجين على نفس الجدول — تعارض حقيقي. */
    trg_applicant_attempts: 'نسخة قديمة؛ الإنتاج يعمل بـ trg_make_attempts',
    trg_applicant_defaults: 'نسخة قديمة؛ الإنتاج يعمل بـ trg_defaults',
    trg_job_defaults: 'نسخة قديمة؛ الإنتاج يعمل بـ trg_defaults'
  },
  /* `lookup_card_unguarded` و`self_service_card_unguarded` مشغّلات بالاسم لا
     مشغّلات فعلية (كود قديم أُعيدت تسميته). الإنتاج يحتفظ بهما كأثر، ولا
     حاجة لهما في قاعدة جديدة — الدوال الفعلية موجودة بأسمائها. */
  triggers: {},
  indexes: {}
};

/** يقيس الفرق الفعلي بين القاعدة الهدف والجرد المرجعي. */
export async function compareToInventory(run) {
  const names = async (q) => (await run(q)).rows.map((r) => r.x);
  const mine = {
    tables: await names(`select table_name x from information_schema.tables where table_schema='brc' and table_type='BASE TABLE'`),
    funcs: await names(`select p.proname x from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='brc'`),
    triggers: await names(`select t.tgname||'@'||c.relname x from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='brc' and not t.tgisinternal`),
    indexes: await names(`select indexname x from pg_indexes where schemaname='brc'`)
  };
  if (!INVENTORY) return { available: false, mine };
  const diff = {};
  let gaps = 0;
  const known = [];
  for (const k of ['tables', 'funcs', 'triggers', 'indexes']) {
    const live = INVENTORY[k] || [];
    const missing = live.filter((x) => !mine[k].includes(x));
    /* ما في ملفنا وليس في الإنتاج ليس نقصاً — قد يكون أحدث. نعرضه للعلم. */
    const extra = mine[k].filter((x) => !live.includes(x));
    const intentional = [], unexpected = [];
    for (const name of missing) {
      if (KNOWN_GAPS[k] && KNOWN_GAPS[k][name]) intentional.push({ name, why: KNOWN_GAPS[k][name] });
      else unexpected.push(name);
    }
    gaps += unexpected.length;
    diff[k] = { missing, extra, unexpected, intentional };
    known.push(...intentional);
  }
  return {
    available: true, matched: gaps === 0, gaps, diff, intentional: known,
    capturedAt: INVENTORY.captured_at
  };
}

/* الأعداد التي يجب أن تظهر في القاعدة الهدف بعد التنفيذ */export const EXPECTED_TABLES = [
  'staff', 'applicants', 'jobs', 'job_attempts', 'issued_serials',
  'card_number_registry', 'card_number_counter', 'card_issue_requests', 'app_secrets',
  'audit_log', 'settings', 'employer_job_credentials',
  'recovery_chances', 'recovery_prints', 'recovery_control',
  'recovery_copies', 'office_receipts'
];

/* جدول المقارنة النهائي — يأتي في آخر الملف نفسه كمرجع للقارئ.
   نعيد إنتاجه من القاعدة الحقيقية لا من الملف، ليكون الحكم من المصدر. */
export function countsSql() {
  return EXPECTED_TABLES.map((t) => `select '${t}' as t, count(*)::int as n from brc.${t}`)
    .join('\nunion all\n') + '\norder by 1';
}

/**
 * يقسّم نص SQL إلى دفعات قابلة للتنفيذ.
 * الدفعة = جملة واحدة أو أكثر، لكن **لا تُقطع جملة أبداً**.
 * @param {string} sql
 * @param {number} maxBytes سقف تقريبي لحجم الدفعة
 * @returns {string[]}
 */
export function batchStatements(sql, maxBytes = 131072) {
  const stmts = splitStatements(sql);
  const batches = [];
  let cur = '';
  for (const st of stmts) {
    /* الجملة الواحدة الأكبر من السقف تبقى وحدها — لا تُقطَع */
    if (cur && cur.length + st.length > maxBytes) { batches.push(cur); cur = ''; }
    cur += st;
  }
  if (cur.trim()) batches.push(cur);
  return batches;
}

/* كشف «هل القاعدة الهدف مستعملة؟» — قبل أي مسح.
   ⚠️ لا نحكم من ملف المالك: نحكم من القاعدة نفسها. */
export async function inspectTarget(run) {
  const out = { reachable: false, hasBrc: false, counts: {}, tables: 0, prereq: {} };
  try {
    const r = await run(`select count(*)::int as n from information_schema.schemata where schema_name='brc'`);
    out.reachable = true;
    out.hasBrc = Number(r.rows[0].n) > 0;
  } catch (e) {
    return { ...out, error: e.message };
  }
  /* ═══ فحص المتطلبات قبل التنفيذ ═══
     الملف يفترض أن القاعدة **قاعدة Supabase**: سكيما auth بدوالها، وسكيما
     extensions. وهذان موجودان في أي مشروع Supabase. لكن رابطاً خاطئاً قد
     يشير إلى PostgreSQL عادي — فيفشل الاسترجاع في منتصفه. نكتشف ذلك قبل
     أي تغيير. */
  const hasObj = async (q) => { try { const r = await run(q); return Number(r.rows[0] ? r.rows[0].n : 0) > 0; } catch (e) { return false; } };
  out.prereq.authUid = await hasObj(`select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='auth' and p.proname='uid'`);
  out.prereq.authJwt = await hasObj(`select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='auth' and p.proname='jwt'`);
  out.prereq.authUsers = await hasObj(`select count(*)::int as n from information_schema.tables where table_schema='auth' and table_name='users'`);
  out.prereq.extensions = await hasObj(`select count(*)::int as n from information_schema.schemata where schema_name='extensions'`);
  out.looksLikeSupabase = out.prereq.authUid && out.prereq.authJwt && out.prereq.authUsers;
  if (!out.hasBrc) return out;
  try {
    const r = await run(`select count(*)::int as n from information_schema.tables where table_schema='brc'`);
    out.tables = Number(r.rows[0].n);
  } catch (e) { /* لا شيء */ }
  for (const t of EXPECTED_TABLES) {
    try {
      const r = await run(`select count(*)::int as n from brc.${t}`);
      out.counts[t] = Number(r.rows[0].n);
    } catch (e) { out.counts[t] = null; }
  }
  return out;
}

/**
 * ينفّذ ملف الاسترجاع كاملاً على قاعدة الهدف، ويُبلّغ عن كل مرحلة.
 * @param {object} o
 * @param {(sql:string)=>Promise<{rows:any[]}>} o.run  منفّذ جملة/دفعة
 * @param {string} o.sql                               نص الملف
 * @param {(ev:object)=>void} [o.onProgress]           تقرير التقدّم
 */
export async function executeDump({ run, sql, query, onProgress = () => {} }) {
  /* `query` منفصل عن `run` لأن PGlite تُرجع نتيجة الاستعلام من `db.query`
     بينما `db.exec` للدفعات بلا صفوف راجعة. سائق `pg` واحد للاثنين. */
  const q = query || run;
  if (typeof sql !== 'string' || sql.length < 1000) {
    throw new Error('ملف الاسترجاع فارغ أو ناقص — أوقفتُ التنفيذ قبل أي تغيير.');
  }
  const batches = batchStatements(sql);
  const report = { batches: batches.length, done: 0, failed: null, errors: [] };
  onProgress({ phase: 'start', batches: batches.length });

  for (let i = 0; i < batches.length; i++) {
    try {
      await run(batches[i]);
      report.done++;
      if (i % 5 === 0 || i === batches.length - 1) {
        onProgress({ phase: 'batch', done: report.done, total: batches.length });
      }
    } catch (e) {
      /* ⚠️ لا نرمي رسالة عامة: نُبلّغ عن أول جملة فاشلة مع موقعها، لأن
         «فشل الاسترجاع» بلا موقع لا يُصلح شيئاً. الملف مقسّم إلى مراحل
         معاملات، فما تم قبلها ثابت — والتحقق النهائي يقيس الفرق. */
      report.failed = { batch: i + 1, total: batches.length, message: e.message, code: e.code };
      report.errors.push(report.failed);
      onProgress({ phase: 'error', batch: i + 1, total: batches.length, message: e.message });
      /* نكمل فقط إن كان الخطأ في مرحلة لاحقة قابلة للتجاهل. الأأمن: نتوقف
         ونعرض ما بقي، لأن مواصلة تنفيذ بيانات فوق هيكل ناقص تنتج قاعدة
         تبدو سليمة وهي ليست كذلك. */
      break;
    }
  }
  /* ما بعد الاسترجاع: مفاتيح داخل القاعدة بلا أسرار في الملف أو السجل.
     نسخة 2026-11-21 لا تتضمن brc.app_secrets؛ نطبّق الإصلاح الآمن من الملف
     المحلي ثم نولّد brc_secret داخل PostgreSQL، ونفحص بصمة مؤقتة بطول 64 فقط.
     لا نطبع المفتاح ولا نقرأ قيمته إلى التطبيق. */
  if (!report.failed) {
    try {
      const fallbackSql = readFileSync(resolve(ROOT, 'docs/sql-parts/fixes/04-brc-secret-fallback.sql'), 'utf8');
      await run(fallbackSql);
      await q(`insert into brc.app_secrets(name, value)
               values ('brc_secret', encode(extensions.gen_random_bytes(32), 'hex'))
               on conflict (name) do nothing`);
      await q(`insert into brc.recovery_control(singleton, secret)
               values (true, encode(extensions.gen_random_bytes(32), 'hex'))
               on conflict (singleton) do nothing`);
      const post = await q(`select
        (select count(*)::int from brc.recovery_control) as recovery_control_rows,
        (select count(*)::int from brc.app_secrets where name='brc_secret') as app_secret_rows,
        length(brc.verify_token('HRC-RESTORE-CHECK'))::int as token_length`);
      report.postRestore = {
        recoveryControlRows: Number(post.rows[0]?.recovery_control_rows || 0),
        appSecretRows: Number(post.rows[0]?.app_secret_rows || 0),
        tokenLength: Number(post.rows[0]?.token_length || 0)
      };
      if (report.postRestore.recoveryControlRows !== 1 ||
          report.postRestore.appSecretRows !== 1 || report.postRestore.tokenLength !== 64) {
        report.failed = {
          batch: batches.length, total: batches.length,
          message: 'فشل فحص post-restore للمفاتيح الداخلية أو brc.verify_token.',
          code: 'HRC_POST_RESTORE_SECRET_CHECK_FAILED'
        };
      }
    } catch (e) {
      report.postRestore = { recoveryControlRows: null, appSecretRows: null, tokenLength: null };
      report.failed = {
        batch: batches.length, total: batches.length,
        message: 'تعذّر إعداد/فحص المفاتيح الداخلية بعد الاسترجاع.',
        code: e.code || 'HRC_POST_RESTORE_FAILED'
      };
    }
  }

  let counts = null;
  try {
    const r = await q(countsSql());
    counts = (r && r.rows) || [];
  } catch (e) { /* الهيكل لم يكتمل — يظهر في التقرير كـnull */ }
  report.counts = counts;
  /* ⚠️ الفحص الحقيقي: لا نكتفي بعدّ الصفوف — نقارن كائنات القاعدة بسجل
     الإنتاج. الحكم «نجح» بلا هذه المقارنة تضليل. */
  try { report.inventory = await compareToInventory(q); } catch (e) { report.inventory = { available: false, error: e.message }; }
  onProgress({ phase: 'done', ...report });
  return report;
}
