// ============================================================
// EcomModa — Duplicate Order Checker Worker (v2.3.0)
// skills: worker-builder v3.1.0 · constants v2.2.0 — 12-09-2026
// ============================================================
// يستقبل Shopify webhook "orders/create" (مسجَّل من Admin UI) على مسار
// مخصّص POST /webhook، يرد 200 فوري، وبعدين في الخلفية بيفحص لو فيه
// أوردر تاني غير منفَّذ في آخر 90 يوم بنفس رقم تليفون الشحنة. لو لقى،
// بيضيف تاج ونوت على الأوردر الجديد.
//
// ⚠️ CHANGELOG v2.3.0 (12-09-2026) — واجهة عرض السجل (قراءة فقط):
//   - §AUTH: check_employee · register_pin · verify_employee · log_logout
//     · get_employees — عشان شاشة الدخول الإلزامية في الواجهة الجديدة.
//     ⚠️ الأداة **مش** بتكتب صفوف login/logout في D1 — راجع §AUTH::no-login-log.
//   - §LOG-ENDPOINTS اتحدّثت لـ Log Filter Model v2: فلاتر قوايم
//     (employees · types) + dateFrom/dateTo من مصدر واحد (logParamsFrom)،
//     ترتيب server-side بقائمة بيضاء (LOG_SORT_COLUMNS)، و get_logs_export
//     بقى بيرجّع { cap, total, truncated } عشان الواجهة تحذّر لو الملف اتقص.
//   - get_config (نسخة الـ Worker) + diag (فحص ذاتي بدون أي كتابة).
//   - 🔒 منطق الويبهوك والفحص والتاجات والنوت **ما اتلمسش ولا حرف** —
//     كل الإضافات قراءة فقط أو تحقق دخول. الأداة مابتكتبش على شوبيفاي
//     غير من مسار الويبهوك اللي كان موجود من v2.2.0.
//
// ⚠️ CHANGELOG v2.2.0 (2026-08-09):
//   - الـ webhook branch بقى بيتفحص بالمسار (POST /webhook) مش بالـ
//     method لوحده — توحيد مع باقي الـ Workers (stylebox-stock-sync,
//     draft-to-live-cod-order). لازم تتنشر النسخة دي وتتأكد إنها شغالة
//     الأول، وبعدين تعدّل الـ destination URL في Shopify Admin →
//     Settings → Notifications → Webhooks → "Order creation" → Edit
//     من الـ root URL لـ .../webhook (نفس الـ signing secret بيفضل
//     زي ما هو، مش محتاج تسجّل webhook جديد). لو الترتيب اتقلب هيرجع
//     404 لحد ما النشر يخلص.
//   - إضافة empty-payload guard قبل أي claim/processing (order.id
//     مفقود = log + 200، مش معالجة بـ orderId="undefined").
//
// ENV VARS (Cloudflare Dashboard → Settings → Variables):
//   Secret:    CLIENT_ID, CLIENT_SECRET, WORKER_SECRET
//              SHOPIFY_WEBHOOK_SECRET  ← مفتاح المتجر من
//                Settings → Notifications → Webhooks (مشترك بين كل
//                ويبهوكات الـ Admin — مش CLIENT_SECRET)
//   Plaintext: SHOP_DOMAIN = 6c7e1a-53.myshopify.com   ← من [vars] في wrangler.toml
//              DUPLICATE_TAG, DUPLICATE_NOTE_PREFIX (اختياريين)
//   D1:        DB → ecommoda-dev-logs
//
// ⚠️ اكتب أسماء الـ Variables يدويًا — الـ Dashboard بيقبل مسافة زيادة
//    في الاسم بصمت والعمود بيقطعه فمش بتبان (سبب فشل HMAC 100% سابقًا).
//
// ⚠️ D1 setup — سطر واحد في D1 Console قبل أول نشر:
//   CREATE TABLE IF NOT EXISTS duplicate_order_check_processed (resource_id TEXT PRIMARY KEY, event_id TEXT, source TEXT, status TEXT, order_id TEXT, order_name TEXT, created_at TEXT, completed_at TEXT);
// ============================================================

// ══════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════
const TOOL_NAME = 'duplicate_order_check';

// نسخة الـ Worker — بترجع من ?action=get_config، والواجهة بتقارنها بـ
// MIN_WORKER_VERSION بتاعتها (Standards #29). أي endpoint أو حقل جديد
// هنا = رفع الرقم ده + رفع MIN_WORKER_VERSION في index.html في نفس التسليم.
const WORKER_VERSION = '2.3.0';

// الـ path المخصّص لاستقبال الـ Shopify webhook — لازم يطابق الـ
// destination URL المسجَّل في Shopify Admin بالظبط (.../webhook)
const WEBHOOK_PATH = '/webhook';

// ⚠️ NOTE (2026-07-30): نطاق البحث مقصور عمدًا على آخر 90 يوم — قرار من
// Ahmed/EcomModa لتفادي سحب كل أوردرات المتجر (9,999+) مع كل webhook.
// أوردرات أقدم من 90 يوم مش بتتفحص كتكرار محتمل. لو ظهرت حالة تكرار
// حقيقية أقدم من كده، لازم نراجع القرار (راجع HANDOFF-other-workers.md).
const LOOKBACK_DAYS = 90;

// شبكة أمان — مع فلتر 90 يوم + unfulfilled، تجاوز 5,000 يعني حجم غير متوقع
const MAX_PAGES = 20;

const PROCESSED_TABLE = 'duplicate_order_check_processed';

// ══════════════════════════════════════════════════════
// §CORS — Option A (الأداة قراءة فقط من ناحية الواجهة)
// ══════════════════════════════════════════════════════
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
function getCORS(_req) { return CORS_HEADERS; }

// ══════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, getCORS(request));
  return new Response(JSON.stringify(data), { status, headers });
}

// ── §HELPERS::safeEqual ──
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── §HELPERS::verifyShopifyHmac ──
async function verifyShopifyHmac(secret, rawBody, headerHmac) {
  if (!secret || !headerHmac) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret.trim()),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig    = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const digest = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return safeEqual(digest, headerHmac);
}

// ── §HELPERS::normalizePhone ──
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('002')) digits = digits.slice(3);
  if (digits.startsWith('20') && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  return digits;
}

// ── §HELPERS::getLookbackDateISO ──
function getLookbackDateISO() {
  const d = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ══════════════════════════════════════════════════════
// §SHARED — D1 Auth & Logging (verbatim من shared-functions.md
// + امتداد الفلاتر الموثّق في نفس الملف)
// ══════════════════════════════════════════════════════

/**
 * Verify employee and return display_name if correct.
 * Returns: string (display_name) or null if wrong PIN.
 * Throws: Error if account is suspended.
 */
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();

  if (!row) return null;

  if (!row.is_active) {
    throw new Error('الحساب موقوف — تواصل مع المسؤول');
  }

  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username)
    .run()
    .catch(() => {});

  return row.display_name;
}

/**
 * Check if employee exists and has a PIN registered.
 */
async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row) return { exists: false, hasPin: false, isActive: false };
  return {
    exists:   true,
    hasPin:   !!row.pin,
    isActive: !!row.is_active,
  };
}

/**
 * Register PIN for the first time.
 */
async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');

  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?')
    .bind(pin, username)
    .run();

  return true;
}

async function writeLog(db, entry) {
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    entry.extra ? JSON.stringify(entry.extra) : null
  ).run();
}

const LOG_EXPORT_MAX = 2000;   // سقف التصدير — بيرجع للواجهة كـ `cap`

/**
 * بنّاء شرط الفلترة الموحّد للسجل — التلات دوال تحته بتستخدمه، فمفيش SQL
 * مكرر يتعتّق في واحدة منهم ويسيب التانية.
 *
 * ⚠️ dateFrom/dateTo بيتقارنوا بـ substr(timestamp,1,10) — يعني **UTC**،
 *    والعرض بتوقيت القاهرة. فرق الساعات ممكن يحط عملية متأخرة بالليل في يوم
 *    UTC اللي بعده. مقبول لفلتر بالأيام — بس مكتوب عشان مايتكتشفش كباج بعدين.
 */
function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
  search    = null,
  dateFrom  = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) {
    sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps);
  }
  if (typs.length) {
    sql += ` AND type IN (${typs.map(() => '?').join(',')})`; b.push(...typs);
  }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }

  return { sql, b };
}

// ⚠️ قائمة **مقفولة** — القيمة جاية من العميل وبتتلزق في نص SQL مباشرةً
//    (ORDER BY مابيقبلش bind). أي قيمة بره القايمة بترجع للافتراضي بدون خطأ.
// ⚠️ المفاتيح لازم تطابق `data-sort-key` في الواجهة **حرفيًا**.
const LOG_SORT_COLUMNS = {
  date: 'timestamp', time: 'timestamp', employee: 'employee',
  type: 'type', orderName: 'order_name', notes: 'notes',
};

function orderByClause(sortBy, sortDir) {
  const col = LOG_SORT_COLUMNS[String(sortBy || '')] || 'timestamp';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 🔴 كاسر تعادل إلزامي: من غيره صفوف نفس القيمة بترتيب عشوائي بين الصفحات،
  //    والصف الواحد ممكن يظهر في صفحتين **أو مايظهرش خالص**.
  return col === 'timestamp' ? ` ORDER BY timestamp ${dir}`
                             : ` ORDER BY ${col} ${dir}, timestamp DESC`;
}

async function getLogs(db, { limit = 100, offset = 0, sortBy, sortDir, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + orderByClause(sortBy, sortDir) + ' LIMIT ? OFFSET ?';
  return (await db.prepare(q)
    .bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

/**
 * ⚠️ الدالة دي **بتقص في السكوت** عند LOG_EXPORT_MAX — الـ endpoint اللي
 * بينادها لازم يرجّع cap/total/truncated، والواجهة لازم تعرض بانر ثابت.
 */
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  // التصدير والعدّ بيتجاهلوا الترتيب عن قصد — مصدر باراميترات مختلف بين
  // النداءات = تصدير مش مطابق للشاشة.
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

/**
 * بيقرا فلاتر السجل من الـ query string — CSV للقوايم
 * (employees=ahmed,sara · types=duplicate_found,checked_clear).
 * الاسم المفرد لسه مقبول للتوافق الرجعي.
 */
function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  return {
    tool,
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    type:      url.searchParams.get('type')     || null,
    search:    url.searchParams.get('search')   || null,
    dateFrom:  url.searchParams.get('dateFrom') || null,
    dateTo:    url.searchParams.get('dateTo')   || null,
  };
}

// ══════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════
async function getAccessToken(env) {
  const resp = await fetch(`https://${env.SHOP_DOMAIN.replace(/\/$/, '')}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
    }).toString(),
  });
  if (!resp.ok) throw new Error(`OAuth failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token;
}

async function shopifyGQL(env, token, query, variables = {}) {
  const resp = await fetch(
    `https://${env.SHOP_DOMAIN.replace(/\/$/, '')}/admin/api/2026-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  if (data.errors) throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  return data;
}

const ORDER_NOTE_QUERY = `
  query getOrderNote($id: ID!) {
    order(id: $id) { note }
  }
`;

const ORDERS_QUERY = `
  query FindDuplicates($cursor: String, $searchQuery: String!) {
    orders(
      first: 250,
      after: $cursor,
      query: $searchQuery,
      sortKey: CREATED_AT,
      reverse: true
    ) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name shippingAddress { phone } } }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation addTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { message }
    }
  }
`;

const ORDER_UPDATE_NOTE_MUTATION = `
  mutation orderUpdateNote($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id note }
      userErrors { field message }
    }
  }
`;

// ── §SHOPIFY::getOrderNote ──
async function getOrderNote(env, accessToken, orderGid) {
  const data = await shopifyGQL(env, accessToken, ORDER_NOTE_QUERY, { id: orderGid });
  return data.data.order?.note || '';
}

// ── §SHOPIFY::findAllDuplicatesByPhone ──
async function findAllDuplicatesByPhone(env, accessToken, targetPhone, currentOrderGid) {
  const matches = [];
  let cursor = null;
  let pages = 0;

  // ⚠️ فلتر الـ 90 يوم — راجع LOOKBACK_DAYS في §CONSTANTS
  const searchQuery = `fulfillment_status:unfulfilled AND NOT status:cancelled AND created_at:>=${getLookbackDateISO()}`;

  while (pages < MAX_PAGES) {
    const data = await shopifyGQL(env, accessToken, ORDERS_QUERY, { cursor, searchQuery });
    const orders = data.data.orders.edges;

    for (const edge of orders) {
      const order = edge.node;
      if (order.id === currentOrderGid) continue;
      const orderPhone = normalizePhone(order.shippingAddress?.phone);
      if (orderPhone && orderPhone === targetPhone) {
        matches.push({ id: order.id, name: order.name });
      }
    }

    if (!data.data.orders.pageInfo.hasNextPage) break;
    cursor = data.data.orders.pageInfo.endCursor;
    pages++;
  }

  return { matches, scanCapped: pages >= MAX_PAGES, pagesScanned: pages + 1 };
}

// ══════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    // 1. OPTIONS preflight — دايمًا أول حاجة
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCORS(request) });
    }

    const url = new URL(request.url);

    // 2. فرع الـ Webhook — بمسار مخصّص POST /webhook، قبل بوابة
    //    WORKER_SECRET (Shopify مبيبعتش Bearer). لازم يطابق الـ
    //    destination URL المسجَّل في Shopify Admin بالظبط.
    if (url.pathname === WEBHOOK_PATH && request.method === 'POST') {
      return handleWebhook(request, env, ctx);
    }

    // 3. بوابة WORKER_SECRET — كل حاجة تانية
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.WORKER_SECRET}`) {
      return json({ ok: false, error: 'Unauthorized' }, 401, request);
    }

    const action = url.searchParams.get('action') || '';

    try {
      // ─── §AUTH — Universal D1 Auth (قراءة/تحقق فقط) ───────
      //
      // §AUTH::no-login-log — قرار موثّق (12-09-2026):
      // الأداة دي **مابتكتبش** صفوف `login`/`logout` في D1. قالب
      // auth-endpoints.md بيكتبهم، بس `ecommoda-constants` §7 مسجّل
      // `duplicate_order_check` بـ 4 قيم type بس (checked_clear ·
      // duplicate_found · hmac_failed · skipped) — وRule 7 بتمنع كتابة
      // أي قيمة مش مسجّلة هناك الأول. فالدخول بيتحقق ومابيتسجّلش.
      // لو اتقرر تسجيله لاحقًا: تتسجّل القيمتين في §7 **الأول**، وبعدين
      // يترجّع الـ writeLog هنا (ومعاه رفع WORKER_VERSION).
      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
        const result = await checkEmployee(env.DB, username);
        return json({ ok: true, ...result }, 200, request);
      }

      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        await registerPin(env.DB, username, pin);
        return json({ ok: true }, 200, request);
      }

      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);

        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);

        // logged: false ثابتة — مش فشل كتابة، ده قرار §AUTH::no-login-log فوق.
        return json({ ok: true, displayName, logged: false }, 200, request);
      }

      if (action === 'log_logout') {
        // بيرد ok عشان الواجهة ماتتعلقش — مفيش كتابة (§AUTH::no-login-log)
        return json({ ok: true, logged: false }, 200, request);
      }

      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results }, 200, request);
      }

      // ─── §CONFIG-ENDPOINTS ────────────────────────────────
      if (action === 'get_config') {
        return json({ ok: true, version: WORKER_VERSION, tool: TOOL_NAME }, 200, request);
      }

      // فحص ذاتي — بدون أي كتابة، وبدون أي قيمة سر (أسماء وأطوال بس)
      if (action === 'diag') {
        const checks = [];

        const secretNames = ['WORKER_SECRET', 'CLIENT_ID', 'CLIENT_SECRET', 'SHOPIFY_WEBHOOK_SECRET'];
        for (const name of secretNames) {
          const v = env[name];
          checks.push({
            ok:     typeof v === 'string' && v.length > 0,
            label:  `Secret: ${name}`,
            detail: typeof v === 'string' && v.length > 0 ? `موجود (${v.length} حرف)` : 'ناقص أو فاضي',
          });
        }

        checks.push({
          ok:     !!env.SHOP_DOMAIN,
          label:  'Var: SHOP_DOMAIN',
          detail: env.SHOP_DOMAIN || 'ناقص — كل نداء شوبيفاي هيفشل برسالة غامضة',
        });

        checks.push({
          ok:     true,
          label:  'Binding names (env keys)',
          detail: Object.keys(env).join(' · '),
        });

        try {
          const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM logs WHERE tool = ?')
            .bind(TOOL_NAME).first();
          checks.push({ ok: true, label: 'D1 (DB → logs)', detail: `متصل — ${row?.n ?? 0} صف لهذه الأداة` });
        } catch (e) {
          checks.push({ ok: false, label: 'D1 (DB → logs)', detail: `FAILED: ${e.message}` });
        }

        try {
          await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${PROCESSED_TABLE}`).first();
          checks.push({ ok: true, label: `D1 (${PROCESSED_TABLE})`, detail: 'الجدول موجود' });
        } catch (e) {
          checks.push({ ok: false, label: `D1 (${PROCESSED_TABLE})`, detail: `FAILED: ${e.message}` });
        }

        checks.push({
          ok:     true,
          label:  'Webhook path',
          detail: `POST ${WEBHOOK_PATH} — لازم يطابق الـ destination في Shopify Admin`,
        });

        checks.push({
          ok:     true,
          label:  'Origin',
          detail: request.headers.get('Origin') || '—',
        });

        return json({ ok: true, version: WORKER_VERSION, checks }, 200, request);
      }

      // ─── §LOG-ENDPOINTS — Log Filter Model v2 ─────────────
      if (action === 'get_logs') {
        const p = logParamsFrom(url, TOOL_NAME);
        // 🔴 parseInt('abc') → NaN · Math.min(NaN,100) → NaN → بيوصل لـ D1
        //    كـ bind ويرجّع خطأ غامض. الحراسة إلزامية، مش تجميل.
        const limitRaw  = parseInt(url.searchParams.get('limit')  || '100', 10);
        const offsetRaw = parseInt(url.searchParams.get('offset') || '0',   10);
        const limit  = Number.isFinite(limitRaw)  ? Math.min(Math.max(limitRaw, 1), 100) : 100;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

        const sortBy  = url.searchParams.get('sortBy');
        const sortDir = url.searchParams.get('sortDir');
        const entries = await getLogs(env.DB, { ...p, limit, offset, sortBy, sortDir });
        return json({ ok: true, entries }, 200, request);
      }

      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logParamsFrom(url, TOOL_NAME));
        return json({ ok: true, total }, 200, request);
      }

      if (action === 'get_logs_export') {
        const p = logParamsFrom(url, TOOL_NAME);
        const [entries, total] = await Promise.all([
          getLogsExport(env.DB, p),
          getLogsCount(env.DB, p),          // العدّ الحقيقي جنب الصفوف
        ]);
        return json({ ok: true, entries, cap: LOG_EXPORT_MAX, total,
                      truncated: total > LOG_EXPORT_MAX }, 200, request);
      }

      // قيم type الموجودة فعليًا في السجل — بتغذّي فلتر "نوع العملية"
      // multi-select في الواجهة من غير ما الواجهة تخمّن القيم.
      if (action === 'get_log_types') {
        const { results } = await env.DB.prepare(
          `SELECT type, COUNT(*) AS n FROM logs
            WHERE tool = ? AND type NOT IN ('login','logout')
            GROUP BY type ORDER BY n DESC`
        ).bind(TOOL_NAME).all();
        return json({ ok: true, types: results }, 200, request);
      }
      // ──────────────────────────────────────────────────────

      return json({ ok: false, error: 'Unknown action' }, 400, request);
    } catch (err) {
      return json({ ok: false, error: err.message }, 500, request);
    }
  },
};

// ─── §WEBHOOK::handleWebhook ───
async function handleWebhook(request, env, ctx) {
  const rawBody = await request.text();   // raw bytes قبل أي parse
  const hmacHdr = request.headers.get('X-Shopify-Hmac-Sha256') || '';
  const eventId = request.headers.get('X-Shopify-Event-Id') ||
                  request.headers.get('X-Shopify-Webhook-Id') || null;
  const topic   = request.headers.get('X-Shopify-Topic') || null;

  const valid = await verifyShopifyHmac(env.SHOPIFY_WEBHOOK_SECRET, rawBody, hmacHdr);

  if (!valid) {
    ctx.waitUntil(writeLog(env.DB, {
      tool: TOOL_NAME, type: 'hmac_failed',
      notes: 'HMAC verification FAILED — راجع SHOPIFY_WEBHOOK_SECRET (الاسم والقيمة)',
      extra: {
        eventId, topic,
        hmacHeaderPresent: !!hmacHdr,
        bodyBytes:         rawBody.length,
        secretPresent:     !!env.SHOPIFY_WEBHOOK_SECRET,
        envKeys:           Object.keys(env),   // يكشف أي خطأ في اسم الـ binding
      },
    }).catch(() => {}));
    return new Response('Unauthorized', { status: 401 });
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch {
    ctx.waitUntil(writeLog(env.DB, {
      tool: TOOL_NAME, type: 'skipped',
      notes: 'Payload مش JSON صحيح رغم نجاح HMAC', extra: { eventId, topic },
    }).catch(() => {}));
    return json({ received: true, parsed: false }, 200);
  }

  // ⚠️ Empty/malformed-payload guard — بعض events بترجع payload فاضي
  // (شوفناها فعليًا على inventory_levels/update). من غير الفحص ده كان
  // ممكن يعمل claim بـ orderId="undefined" ويكمل معالجة وهمية.
  if (!order || !order.id) {
    ctx.waitUntil(writeLog(env.DB, {
      tool: TOOL_NAME, type: 'skipped',
      notes: 'Payload فاضي أو من غير order.id رغم نجاح HMAC',
      extra: { eventId, topic },
    }).catch(() => {}));
    return json({ received: true, parsed: true, empty: true }, 200);
  }

  // رد 200 فوري — الشغل الحقيقي في الخلفية (قاعدة الـ 5 ثواني)
  ctx.waitUntil(processOrder(order, env, eventId));

  return json({ received: true, order: order.name }, 200);
}

// ─── §WEBHOOK::processOrder ───
async function processOrder(order, env, eventId) {
  const orderId          = String(order.id);
  const currentOrderGid  = order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`;
  const currentOrderName = order.name;

  // Idempotency claim — INSERT OR IGNORE ذرّي، قبل أي كتابة
  const claim = await env.DB.prepare(`
    INSERT OR IGNORE INTO ${PROCESSED_TABLE}
      (resource_id, event_id, source, status, order_id, order_name, created_at)
    VALUES (?, ?, 'shopify_webhook', 'processing', ?, ?, ?)
  `).bind(orderId, eventId, orderId, currentOrderName, new Date().toISOString()).run();

  if ((claim.meta?.changes ?? 0) === 0) {
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'skipped', orderId, orderName: currentOrderName,
      notes: 'اتعالج قبل كده أو لسه شغّال — إعادة الإرسال اتجاهلت', extra: { eventId },
    }).catch(() => {});
    return;
  }

  try {
    const currentPhone = normalizePhone(order.shipping_address?.phone);

    if (!currentPhone) {
      await markCompleted(env, orderId);
      await writeLog(env.DB, {
        tool: TOOL_NAME, type: 'skipped', orderId, orderName: currentOrderName,
        notes: 'مفيش رقم تليفون شحن على الأوردر',
      }).catch(() => {});
      return;
    }

    const accessToken = await getAccessToken(env);
    const { matches, scanCapped, pagesScanned } =
      await findAllDuplicatesByPhone(env, accessToken, currentPhone, currentOrderGid);

    if (scanCapped) {
      await writeLog(env.DB, {
        tool: TOOL_NAME, type: 'scan_capped', orderId, orderName: currentOrderName,
        notes: `وصل لـ MAX_PAGES (${MAX_PAGES}) قبل ما يخلّص نطاق الـ ${LOOKBACK_DAYS} يوم`,
        extra: { pagesScanned },
      }).catch(() => {});
    }

    if (matches.length === 0) {
      await markCompleted(env, orderId);
      await writeLog(env.DB, {
        tool: TOOL_NAME, type: 'checked_clear', orderId, orderName: currentOrderName,
        notes: `مفيش تكرار في آخر ${LOOKBACK_DAYS} يوم`, extra: { pagesScanned },
      }).catch(() => {});
      return;
    }

    const matchedNames = matches.map(o => o.name).join(', ');
    const prefix       = env.DUPLICATE_NOTE_PREFIX || 'Possible duplicate orders';
    const newNoteLine  = `${prefix} ${matchedNames}`;

    // قراءة النوت الحالي قبل الإضافة — بيحافظ على سطور Workers تانية
    const existingNote = await getOrderNote(env, accessToken, currentOrderGid);
    const finalNote = existingNote ? `${existingNote}\n${newNoteLine}` : newNoteLine;

    const tag = env.DUPLICATE_TAG || 'Duplicate';
    await shopifyGQL(env, accessToken, TAGS_ADD_MUTATION, { id: currentOrderGid, tags: [tag] });
    await shopifyGQL(env, accessToken, ORDER_UPDATE_NOTE_MUTATION, {
      input: { id: currentOrderGid, note: finalNote },
    });

    await markCompleted(env, orderId);
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'duplicate_found', orderId, orderName: currentOrderName,
      notes: `اتحدد كتكرار محتمل لـ: ${matchedNames}`,
      extra: { matches, pagesScanned },
    }).catch(() => {});

  } catch (err) {
    // فك الـ claim عشان أي retry شرعي من Shopify يقدر ينجح
    await env.DB.prepare(`DELETE FROM ${PROCESSED_TABLE} WHERE resource_id = ?`)
      .bind(orderId).run().catch(() => {});
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'skipped', orderId, orderName: currentOrderName,
      notes: `Background processing error: ${err.message}`,
    }).catch(() => {});
  }
}

// ─── §WEBHOOK::markCompleted ───
async function markCompleted(env, orderId) {
  await env.DB.prepare(`
    UPDATE ${PROCESSED_TABLE} SET status = 'completed', completed_at = ? WHERE resource_id = ?
  `).bind(new Date().toISOString(), orderId).run().catch(() => {});
}
