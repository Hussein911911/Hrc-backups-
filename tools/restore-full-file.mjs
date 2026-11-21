#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   HRC — منفّذ ملف الاسترجاع الكامل + تحقّق إلزامي بعده
   ---------------------------------------------------------------------------
   يفعل بالترتيب:
     ١) يفحص الملف: الحجم، SHA-256، عدد العبارات.
     ٢) يرقّع كتلتَي المشغّلات (Supabase لا يسمح بـ … TRIGGER ALL بلا superuser).
     ٣) ينفّذ الملف كاملاً بأداة حقيقية: psql (‏ON_ERROR_STOP=1) أو سائق pg.
     ٤) يشغّل استعلامات التحقّق ويقارن كل رقم بالمتوقّع لهذه النسخة.
     ٥) يطبع PASS/FAIL صريحاً ويُرجع رمز خروج غير صفري عند أي اختلاف.

   الاستخدام:
     # بـ psql (الأفضل: عبارة عبارة، سجل كامل)
     node tools/restore-full-file.mjs <file.sql> --dsn "<dsn>" --yes

     # نسخة أحدث نُزّلت من صفحة النسخ الاحتياطي بعد 2026-11-20 (بصمتها غير معروفة):
     node tools/restore-full-file.mjs <file.sql> --dsn "<dsn>" --allow-new --yes

     # بلا psql (على ويندوز مثلاً): سائق pg من npm — الملف كله في معاملة واحدة
     npm i pg --no-save
     node tools/restore-full-file.mjs <file.sql> --dsn "<dsn>" --driver pg --yes

   ملاحظات سلامة:
     • يقبل مشروع الهدف tkxbmopxcftxpcoczweq فقط، ويرفض أي مضيف/قاعدة/منفذ آخر.
     • TLS يتحقق من الشهادة؛ وDSN يفضّل HRC_RESTORE_DSN محلياً لا argv.
     • يتطلب --yes؛ لا يعيد المحاولة تلقائياً بعد فشل (الملف يبدأ بـ TRUNCATE).
     • بعد الاسترجاع يطبّق fallback محمياً لـ brc_secret وينشئ قيمة داخل DB بلا طباعتها.
   ═══════════════════════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { splitStatements } from './sql-split-core.mjs';
import { patchTriggerBlocks } from './patch-restore-triggers.mjs';
import { headerCounts } from './dump-header.mjs';

const EXPECTED_REF = 'tkxbmopxcftxpcoczweq';
const EXPECTED_HOST = `db.${EXPECTED_REF}.supabase.co`;
const FORBIDDEN_REF = 'vqsvztudvfukyuerzcgx';   // مشروع الإنتاج — محظور نهائياً

/* النسخ المتحقَّق منها. كل نسخة معها أعدادها المقروءة من ترويسة الملف
   وقت التحقّق — فلا تُقارن نسخة أحدث بأرقام نسخة أقدم (خطأ يبدو كفشل). */
const KNOWN = {
  'a1cce0475ae8158cacb523e738cd1bbe34def36dd77787a2fee25763f84ec8ba':
    { bytes: 3858946, statements: 400, label: 'HRC-FULL-2026-11-19' },
  /* أُضيف 2026-11-21 بعد تحقّق كامل: 404 مقطعاً (403 عبارة) · 3,864,629 بايت · بناه المولّد المُصلَح */
  'd47c50857bc1806793670b68d25ec8017a1a4a8158076827c5b9a4ada893aed8': {
    bytes: 3864629, statements: 403, label: 'HRC-FULL-2026-11-21',
    counts: {
      staff: 3, applicants: 726, jobs: 22, job_attempts: 1537, issued_serials: 770,
      card_number_registry: 176, audit_log: 3814, settings: 5,
      recovery_chances: 1537, recovery_prints: 726, office_receipts: 0,
    },
    extra: { printed: 422, spent: 46, counter: 176, cards: 726, disabled_triggers: 0 },
  },
};

const EXPECTED = {
  staff: 3, applicants: 726, jobs: 22, job_attempts: 1537, issued_serials: 770,
  card_number_registry: 176, audit_log: 3809, settings: 5,
  recovery_chances: 1537, recovery_prints: 726, office_receipts: 0,
};
const EXPECTED_EXTRA = { printed: 422, spent: 46, counter: 176, cards: 726, disabled_triggers: 0 };

/* ── أدوات مساعدة ───────────────────────────────────────────────────────── */
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const mask = (s) => String(s).replace(/(:\/\/[^:/@]+:)[^@]*@/, '$1***@');
function die(msg, code = 2) { console.error(`✖ ${msg}`); process.exit(code); }

const file = process.argv[2];
if (!file || file.startsWith('--')) die('الاستخدام: node tools/restore-full-file.mjs <file.sql> --dsn "<dsn>" [--driver psql|pg]');
if (!existsSync(file)) die(`الملف غير موجود: ${file}`);

const dsn = process.env.HRC_RESTORE_DSN || arg('dsn') || null;
if (!dsn || dsn === true) die('مطلوب HRC_RESTORE_DSN محلياً. لا تضع كلمة المرور في المحادثة.');
function assertTargetDsn(value) {
  let u;
  try { u = new URL(String(value)); } catch { throw new Error('رابط PostgreSQL غير صالح.'); }
  if (String(value).includes(FORBIDDEN_REF)) throw new Error('رُفض المشروع المحظور.');
  if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
      u.hostname.toLowerCase() !== EXPECTED_HOST ||
      (u.port || '5432') !== '5432' || decodeURIComponent(u.pathname || '') !== '/postgres' ||
      u.searchParams.has('host')) {
    throw new Error(`يُسمح فقط بمشروع ${EXPECTED_REF}، المضيف المباشر ${EXPECTED_HOST}:5432، وقاعدة postgres.`);
  }
  if (u.searchParams.get('sslmode') === 'disable') throw new Error('TLS إجباري؛ sslmode=disable مرفوض.');
  return true;
}
try { assertTargetDsn(dsn); } catch (e) { die(e.message); }
const secureDsn = (() => { const u = new URL(String(dsn)); u.searchParams.delete('sslmode'); return u.toString(); })();
const driver = String(arg('driver') || process.env.HRC_RESTORE_DRIVER || 'psql');
if (!['psql', 'pg'].includes(driver)) die(`سائق غير معروف: ${driver} (المسموح: psql أو pg)`);
const psql = arg('psql') || process.env.PSQL || 'psql';
const logPath = arg('log') || path.join(process.cwd(), `restore-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const doPatch = !arg('no-patch', false);
const yes = !!arg('yes', false);
const allowNew = !!arg('allow-new', false);
if (!yes) die('الاسترجاع هدّام. راجع اسم الملف وبصمته والعدادات، ثم أعد التشغيل مع --yes فقط بعد تأكيدك.');

/* ── ١) فحص الملف ──────────────────────────────────────────────────────── */
const raw = readFileSync(file);
const sha = createHash('sha256').update(raw).digest('hex');
const text = raw.toString('utf8');
const stmts = splitStatements(text);
/* ملاحظة: لا تستعمل تعبيراً نمطياً هنا — `^\s*(--[^\n]*\s*)+$` يُبتلى بتراجع كارثي
   على عبارة بحجم ٢٫٨ م.ب فيتوقّف التنفيذ بلا نهاية. الفحص سطراً سطراً خطّي وآمن. */
const isCommentOnly = (s) => s.split('\n').every((l) => { const t = l.trim(); return t === '' || t.startsWith('--'); });
const realStatements = stmts.filter((s) => !isCommentOnly(s)).length;
const known = KNOWN[sha];
const logLines = [];
function say(line) { logLines.push(line); console.log(line); }

say('══════ فحص ملف الاسترجاع ══════');
say(`الملف      : ${path.resolve(file)}`);
say(`الحجم      : ${raw.length.toLocaleString('en-US')} بايت`);
say(`SHAsum     : ${sha}`);
say(`العبارات   : ${stmts.length} مقطع (منها ${realStatements} عبارة فعلية + ${stmts.length - realStatements} ذيل تعليقات)`);
/* ── الأعداد المتوقّعة ─────────────────────────────────────────────────────
   للنسخة المعروفة (2026-11-19) تبقى الأرقام المثبّتة هي المرجع — طلب المالك.
   ولنسخة أحدث نُزّلت بعد إصلاح المولّد، تُقرأ الأعداد من ترويسة الملف نفسه
   (يكتبها المولّد من القاعدة، فهي شهادة الملف عن محتواه) بدل تثبيت أرقام
   نسخة قديمة يُفشل التحقّق ظلماً. */
let expected = { ...EXPECTED };
let extra = { ...EXPECTED_EXTRA };
let informational = null;

if (known) {
  say(`النسخة     : ${known.label} — مطابقة للبصمة المعروفة ✔`);
  /* الأعداد المثبّتة مع البصمة تتقدّم على أرقام النسخة القديمة */
  if (known.counts) {
    expected = { ...known.counts };
    extra = { ...(known.extra || EXPECTED_EXTRA) };
  }
} else {
  const hdr = headerCounts(text);
  if (!allowNew) {
    die(
      `البصمة غير معروفة: ${sha.slice(0, 16)}…\n` +
      '  إن كان الملف نسخة أحدث نزّلتها من صفحة النسخ الاحتياطي بعد إصلاح 2026-11-20\n' +
      '  فمرّر --allow-new: تُقرأ الأعداد المتوقّعة من ترويسة الملف بدل تثبيتها.\n' +
      '  وإن لم تكن متأكّداً من الملف فلا تمرّرها — التوقّف هنا أأمن.'
    );
  }
  if (!hdr) die('الملف لا يحمل ترويسة أعداد («--  الأعداد :») — لا يمكن التحقّق آلياً. رُفض التنفيذ.');
  expected = {};
  for (const k of Object.keys(EXPECTED)) {
    if (hdr[k] === undefined) die(`ترويسة الملف تخلو من «${k}» — رُفض التنفيذ بدل تحقّق ناقص.`);
    expected[k] = hdr[k];
  }
  if (hdr.counter === undefined) die('ترويسة الملف تخلو من «عدّاد البطاقات» — رُفض التنفيذ.');
  extra = { cards: expected.applicants, counter: hdr.counter, disabled_triggers: 0 };
  /* printed/spent ليست في الترويسة (تُحسب من الأعلام) — تُعرض ولا تُحاكم */
  informational = ['printed', 'spent'];
  say(`النسخة     : بصمة غير معروفة — تُعامل كنسخة أحدث (--allow-new)`);
  say(`الأعداد    : من ترويسة الملف · عدّاد البطاقات ${hdr.counter}`);
}

/* ── ٢) الترقيع ─────────────────────────────────────────────────────────── */
let sql = text;
if (doPatch) {
  /* allowNone دائماً: «صفر كتل» تعني ملفاً نظيفاً من المولّد المُصلَح، لا خطأ.
     النقص الجزئي (كتلة واحدة من اثنتين) يبقى خطأً ويوقف التنفيذ. */
  const res = patchTriggerBlocks(text, undefined, { allowNone: true });
  sql = res.text;
  if (res.clean) say('ترقيع      : لا حاجة — الملف لا يحوي «TRIGGER ALL» (مولّد مُصلَح بعد 2026-11-20)');
  for (const r of res.replaced) say(`ترقيع      : كتلة «${r.kind}» عند السطر ${r.line} → نسخة تسمّي كل مشغّل (بلا TRIGGER ALL)`);
  say(`ترقيع      : عدد العبارات بعد الترقيع ${res.statements} (بلا تغيير)`);
} else {
  say('⚠ الترقيع معطّل (--no-patch): على مشروع Supabase حديث ستفشل كتلة ENABLE TRIGGER ALL وتُجهض البيانات.');
}

const dir = mkdtempSync(path.join(tmpdir(), 'hrc-restore-'));
const patched = path.join(dir, 'HRC-FULL-patched.sql');
writeFileSync(patched, sql);
say(`ملف مؤقّت  : ${patched}`);

/* ── كلمة المرور تنتقل عبر البيئة (‏PGPASSWORD) لا عبر سطر الأوامر ─────── */
function connEnv(dsnStr) {
  const s = String(dsnStr);
  if (!/^postgres(ql)?:\/\//.test(s)) return { env: {}, extraArgs: ['-d', s] };
  let u;
  try { u = new URL(s); } catch { return { env: {}, extraArgs: ['-d', s] }; }
  const env = {};
  const hostParam = u.searchParams.get('host');
  if (hostParam) env.PGHOST = hostParam;
  else if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname);
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) env.PGDATABASE = db;
  env.PGSSLMODE = 'verify-full';
  return { env, extraArgs: [] };
}
const conn = connEnv(dsn);
/* هل نحتاج TLS؟ نعم إن كان sslmode مطلوباً، أو إن كان المضيف TCP (لا مقبس يونكس) */
function sslFor() {
  /* TLS certificate and hostname must validate; never downgrade verification. */
  return { rejectUnauthorized: true };
}
const baseEnv = {
  ...process.env, ...conn.env,
  PGCLIENTENCODING: 'UTF8',
  PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '30',
  PSQLRC: '/dev/null',
};

/* ── ٣) التنفيذ ─────────────────────────────────────────────────────────── */
say('');
say('══════ التنفيذ ══════');
say(`الهدف      : ${mask(dsn)}`);
say(`السائق     : ${driver}${driver === 'psql' ? ` (${psql})` : ' (npm pg — الملف كله في معاملة واحدة)'}`);
if (driver === 'psql' && !yes) say('(بلا --yes سيسأل psql عن كلمة المرور إن لم تكن في الـ DSN)');
say(`السجل      : ${logPath}`);

const errFrom = (out) => {
  const lines = String(out || '').split('\n');
  const at = [...lines].reverse().find((l) => /^psql:.*:\d+: (ERROR|FATAL)/.test(l))
          || [...lines].reverse().find((l) => /^(ERROR|FATAL):/.test(l)) || '';
  const msg = [...lines].reverse().find((l) => /\b(ERROR|FATAL):/.test(l)) || '(لا رسالة خطأ في المخرجات)';
  return { at, msg };
};

let execOutput = '';
if (driver === 'psql') {
  const run = spawnSync(psql, ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', ...conn.extraArgs, '-f', patched], {
    env: baseEnv, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  execOutput = (run.stdout || '') + (run.stderr || '');
  if (run.error) die(`تعذّر تشغيل psql (${run.error.code || run.error.message}). إن لم يكن مثبتاً استخدم --driver pg`);
  if (run.status !== 0) {
    writeFileSync(logPath, `# HRC restore\n# file=${file}\n# sha256=${sha}\n# dsn=${mask(dsn)}\n# driver=psql\n\n${execOutput}`);
    const { at, msg } = errFrom(execOutput);
    say('');
    say(`✖ فشل التنفيذ — رمز الخروج ${run.status}`);
    if (at) say(`  الموضع : ${at}`);
    say(`  الخطأ  : ${msg}`);
    say('  القاعدة : بعد فشل هنا **لا تُعِد التنفيذ عشوائياً**. افحص حالة brc أولاً (قد تكون المعاملة تراجعت كلياً).');
    say(`  السجل  : ${logPath}`);
    process.exit(1);
  }
  say('✔ psql أنهى الملف برمز خروج 0 (ON_ERROR_STOP=1)');
} else {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: secureDsn, ssl: sslFor(dsn), connectionTimeoutMillis: 30000 });
  try {
    await client.connect();
    say('✔ اتصلت بالقاعدة');
    const t0 = Date.now();
    await client.query(sql);              // بلا معاملات → بروتوكول بسيط → الملف كله معاملة واحدة
    say(`✔ نُفِّذ الملف كاملاً في ${((Date.now() - t0) / 1000).toFixed(1)} ثانية`);
    await client.end();
  } catch (e) {
    writeFileSync(logPath, `# HRC restore\n# file=${file}\n# sha256=${sha}\n# dsn=${mask(dsn)}\n# driver=pg\n\n${execOutput}\n${e.stack || e.message}`);
    say('');
    say('✖ فشل التنفيذ (المعاملة تراجعت — لم يُثبَّت شيء)');
    say(`  الخطأ  : ${e.message}`);
    if (e.position) say(`  الموضع : position ${e.position} داخل الملف المرقّع (${patched})`);
    say(`  السجل  : ${logPath}`);
    try { await client.end(); } catch { /* ignore */ }
    process.exit(1);
  }
}

/* ── ٤) تثبيت سرّ بصمة داخلي آمن والتحقق منه ───────────────────────────
   GUC app.brc_secret غير قابل للضبط في بعض خطط Supabase. نستخدم الحل المشفّر
   في المخطط: جدول بلا سياسات RLS، ودالة SECURITY DEFINER. يُنشأ المفتاح داخل
   PostgreSQL ولا يعود إلى الطرفية أو السجل. */
try {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: secureDsn, ssl: sslFor(), connectionTimeoutMillis: 30000 });
  await client.connect();
  try {
    const fallbackSql = readFileSync(new URL('../docs/sql-parts/fixes/04-brc-secret-fallback.sql', import.meta.url), 'utf8');
    await client.query(fallbackSql);
    await client.query(`insert into brc.app_secrets(name, value)
      values ('brc_secret', encode(extensions.gen_random_bytes(32), 'hex'))
      on conflict (name) do nothing`);
    const check = await client.query(`select
      (select count(*)::int from brc.recovery_control) as recovery_control_rows,
      (select count(*)::int from brc.app_secrets where name='brc_secret') as app_secret_rows,
      length(brc.verify_token('HRC-RESTORE-CHECK'))::int as token_length`);
    const v = check.rows[0] || {};
    if (Number(v.recovery_control_rows) !== 1 || Number(v.app_secret_rows) !== 1 || Number(v.token_length) !== 64) {
      throw new Error('Post-restore secret validation failed (counts/token length mismatch).');
    }
    say('✔ إعداد بديل آمن لـ app.brc_secret جاهز؛ المفتاح بقي داخل PostgreSQL ولم يُعرض');
  } finally { await client.end(); }
} catch (e) {
  die(`فشل إعداد/فحص مفتاح البصمة الداخلي؛ لا تفعّل الموقع: ${e.message}`);
}

/* ── ٥) التحقّق ─────────────────────────────────────────────────────────── */
const countSql = `
select json_build_object(
  'staff', (select count(*) from brc.staff),
  'applicants', (select count(*) from brc.applicants),
  'jobs', (select count(*) from brc.jobs),
  'job_attempts', (select count(*) from brc.job_attempts),
  'issued_serials', (select count(*) from brc.issued_serials),
  'card_number_registry', (select count(*) from brc.card_number_registry),
  'audit_log', (select count(*) from brc.audit_log),
  'settings', (select count(*) from brc.settings),
  'recovery_chances', (select count(*) from brc.recovery_chances),
  'recovery_prints', (select count(*) from brc.recovery_prints),
  'office_receipts', (select count(*) from brc.office_receipts),
  'printed', (select count(*) from brc.recovery_prints where printed),
  'spent', (select count(*) from brc.recovery_chances where spent),
  'counter', (select last_number from brc.card_number_counter),
  'cards', (select count(*) from brc.recovery_prints),
  'disabled_triggers', (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
                          join pg_namespace n on n.oid=c.relnamespace
                         where n.nspname='brc' and not t.tgisinternal and t.tgenabled <> 'O'),
  'auth_linked', (select count(*) from brc.staff where auth_id is not null),
  'recovery_control', (select count(*) from brc.recovery_control),
  'app_secret_rows', (select count(*) from brc.app_secrets where name='brc_secret'),
  'token_length', length(brc.verify_token('HRC-RESTORE-CHECK'))
) as v;`;

let got;
if (driver === 'psql') {
  const ver = spawnSync(psql, ['--no-psqlrc', '-A', '-t', ...conn.extraArgs, '-c', countSql], {
    env: baseEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (ver.status !== 0) die(`تعذّر تشغيل استعلامات التحقّق: ${(ver.stderr || '').trim().split('\n').pop()}`);
  try { got = JSON.parse(ver.stdout.trim()); } catch { die(`مخرجات التحقّق غير مفهومة: ${String(ver.stdout).slice(0, 200)}`); }
} else {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: secureDsn, ssl: sslFor(dsn), connectionTimeoutMillis: 30000 });
  await client.connect();
  const r = await client.query(countSql);
  got = r.rows[0].v;
  await client.end();
}

say('');
say('══════ التحقّق بعد التنفيذ ══════');
let fail = 0;
const rows = [];
for (const [k, want] of Object.entries({ ...expected, ...extra })) {
  const have = Number(got[k]);
  const ok = have === want;
  if (!ok) fail++;
  rows.push(`${ok ? '✔' : '✖'} ${k.padEnd(22)} المتوقع ${String(want).padStart(6)}   الفعلي ${String(have).padStart(6)}`);
}
for (const [k, want] of Object.entries({ recovery_control: 1, app_secret_rows: 1, token_length: 64 })) {
  const have = Number(got[k]);
  const ok = have === want;
  if (!ok) fail++;
  rows.push(`${ok ? '✔' : '✖'} ${k.padEnd(22)} المتوقع ${String(want).padStart(6)}   الفعلي ${String(have).padStart(6)}`);
}
for (const k of informational || []) {
  rows.push(`ℹ ${k.padEnd(22)} (معلوماتي — غير مذكور في الترويسة) ${got[k]}`);
}
rows.push(`ℹ auth_linked            (معلوماتي) ${got.auth_linked} — الروابط تُنشأ بعد إنشاء حسابات Auth`);
rows.forEach(say);
writeFileSync(logPath, `# HRC restore\n# file=${file}\n# sha256=${sha}\n# dsn=${mask(dsn)}\n# driver=${driver}\n\n${execOutput}\n${logLines.join('\n')}\n`);
say('');
if (fail === 0) {
  say(known
    ? `✅ PASS — كل الأعداد مطابقة لنسخة ${known.label}. لا تشغّل الموقع قبل ربط الحسابات ورفع الصور.`
    : '✅ PASS — كل الأعداد مطابقة لترويسة الملف. لا تشغّل الموقع قبل ربط الحسابات ورفع الصور.');
  say(`السجل: ${logPath}`);
} else {
  say(`❌ FAIL — ${fail} قيمة مخالفة. لا تبدأ العمل على هذه القاعدة. السجل: ${logPath}`);
  process.exit(1);
}
