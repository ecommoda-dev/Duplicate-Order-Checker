<div dir="rtl" style="text-align: right;">

# Duplicate Order Checker (`Duplicate-Order-Checker`)

![version](https://img.shields.io/badge/version-v1.0.0-blue)

**بتعمل إيه:** الـ Worker بيفحص كل أوردر جديد تلقائيًا ويكشف لو فيه أوردر تاني غير منفَّذ بنفس رقم تليفون الشحن في آخر ٩٠ يوم، ويحطّ عليه تاج ونوت. الواجهة **بتعرض سجل الفحص ده وبس**.
**مين بيستخدمها:** خدمة العملاء · الإدارة
**الإصدار:** Worker `v2.4.0` · الواجهة `v1.0.0`   ← الاتنين مستقلين، طبيعي يختلفوا

> 🔴 **الواجهة قراءة فقط بقرار صريح.** مفيش زرار بيعدّل أوردر، ولا بيشغّل الفحص يدويًا، ولا بيمسح صف من السجل. أي طلب يضيف فعل هنا = قرار جديد يتاخد من صاحب الأداة الأول.

## الروابط

```
الواجهة    : https://ecommoda-dev.github.io/Duplicate-Order-Checker/
الـ Worker : https://duplicate-order-checker-worker.ecommoda-dev.workers.dev
الويبهوك   : https://duplicate-order-checker-worker.ecommoda-dev.workers.dev/webhook
اسم الـ Worker في الداشبورد: duplicate-order-checker-worker
```

## الـ Endpoints

| `?action=` | بيعمل إيه |
|---|---|
| `get_logs` | صفحة ١٠٠ صف — فلترة وترتيب server-side |
| `get_logs_count` | العدد الكلي المطابق للفلاتر (رقم «النتائج») |
| `get_logs_export` | التصدير حتى `LOG_EXPORT_MAX` + `cap` · `total` · `truncated` |
| `get_log_types` | قيم `type` الموجودة فعليًا — بتغذّي فلتر نوع العملية |
| `get_employees` · `check_employee` · `register_pin` · `verify_employee` · `log_logout` | شاشة الدخول |
| `get_config` | نسخة الـ Worker — لحارس `MIN_WORKER_VERSION` |
| `diag` | فحص ذاتي بدون أي كتابة — مافيهوش قيمة أي سر |
| `POST /webhook` | **مسار مستقل** لاستقبال `orders/create` — قبل بوابة `WORKER_SECRET`. الاشتراك متسجَّل من **Webhook Control Center** (مش من Admin-UI) |

## D1

```
tool  : duplicate_order_check
type  : checked_clear · duplicate_found · hmac_failed · skipped · scan_capped
```

> **مفيش `login`/`logout`** — الأداة بتتحقق من الدخول ومابتسجّلوش، لأن القيمتين مش مسجّلتين لها في `ecommoda-constants` §7 وRule 7 بتفرض التسجيل قبل أول كتابة. التفاصيل في «مسائل مفتوحة».

**جدول إضافي غير `logs`/`employees`:**

```sql
duplicate_order_check_processed (resource_id PK, event_id, source, status, order_id, order_name, created_at, completed_at)
```

> حارس الـ idempotency — `INSERT OR IGNORE` ذرّي قبل أي كتابة، عشان إعادة إرسال الويبهوك ماتعالجش الأوردر مرتين. الصف بيتمسح لو المعالجة فشلت عشان أي retry شرعي من شوبيفاي ينجح.

## المضبوط فعليًا في الداشبورد

```
Bindings : DB → ecommoda-dev-logs
Secrets  : WORKER_SECRET · CLIENT_ID · CLIENT_SECRET · SHOPIFY_WEBHOOK_SECRET
Vars     : SHOP_DOMAIN · DUPLICATE_TAG · DUPLICATE_NOTE_PREFIX
Build watch paths : * (الافتراضي)
```

> 🔴 **`DUPLICATE_NOTE_PREFIX` لسه مش مكتوب في `wrangler.toml`** — لازم يتنسخ من الداشبورد بالحرف **قبل** ربط الريبو بـ Workers Builds، وإلا أول build بيمسحه والنوت بيرجع للـ fallback الإنجليزي على أوردرات حقيقية بدون أي رسالة. الخطوات مكتوبة في `wrangler.toml` نفسه.

## CORS

`wildcard *` — الأداة من ناحية الواجهة **قراءة فقط**، والحماية في `WORKER_SECRET`. مسار الويبهوك مالوش علاقة بالـ CORS (شوبيفاي مش متصفح).

## خط الأساس بعد النقل

> يتملى بعد أول تشغيل ناجح للواجهة (عدد صفوف السجل + تاريخ أقدم صف).

```
— لسه ما اتقاسش
```

## فخاخ الأداة دي

- **مسار الويبهوك `/webhook` مش الـ root.** لو الـ destination في Shopify Admin لسه على الـ root، هيرجع 404 بصمت. (سبب نسخة v2.2.0 كلها.)
- **الاشتراك بقى متسجَّل من الـ API (Webhook Control Center) — يعني التوقيع بـ `CLIENT_SECRET`.** الويبهوك القديم كان من Admin-UI وكان بيتوقّع بمفتاح المتجر (`SHOPIFY_WEBHOOK_SECRET`). الـ Worker من `v2.4.0` بيجرّب الاتنين ويكتب اللي عدّى في `extra.signedWith`. الخلط بينهم = `hmac_failed` متكرر من غير أي عرض تاني.
- **`extra.signedWith` هو الدليل الوحيد على مصدر التسليمة.** `client_secret` = جاية من اشتراك Control Center · `shopify_webhook_secret` = لسه جاية من ويبهوك الـ Admin-UI. مفيش أي فرق تاني ظاهر — لا في الـ payload ولا في الـ headers.
- **ملكية الاشتراك:** اشتراك Control Center شكله في `webhookSubscriptions` بس لو اتسأل بنفس الـ `CLIENT_ID`. ويبهوك الـ Admin-UI مش بيظهر لأي API — الطريقة الوحيدة لمسحه من شاشة Settings → Notifications → Webhooks بإيد.
- **اكتب أسماء الـ Variables بالكيبورد.** اللصق بيسيب مسافة مخفية في الاسم والعمود بيقطعها — سبب فشل HMAC ١٠٠٪ سابقًا.
- **نطاق الفحص ٩٠ يوم بقرار صريح.** أي أوردر أقدم من كده مش بيتفحص كتكرار. `scan_capped` معناها الفحص وقف قبل ما يخلّص النطاق — النتيجة ممكن تكون ناقصة.
- **فلتر التاريخ في الواجهة بيقارن بـ UTC** والعرض بتوقيت القاهرة — عملية متأخرة بالليل ممكن تقع في يوم UTC اللي بعده. مقبول لفلتر بالأيام.
- **عمود «الموظف» في السجل غالبًا فاضي** — الصفوف بيكتبها الويبهوك مش موظف. فلتر الموظف هيرجّع صفر نتايج طول ما مفيش صفوف بموظف، والواجهة بتقول كده صراحةً في رسالة «مفيش نتايج».

## استرجاع النسخ القديمة

```
كود الـ Worker قبل النقل لـ git (v2.2.0) محفوظ في أول commit على الفرع ده.
git log --oneline -- index.js
git show <sha>:index.js
```

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-html-builder | v7.1.0 |
| ecommoda-worker-builder | v3.1.0 |
| ecommoda-constants | v2.2.0 |

آخر مطابقة: 13-09-2026 · `index.js` v2.4.0 · `index.html` v1.0.0
🔴 معلّقة: — لا شيء

## مسائل مفتوحة

0. **شيل الـ fallback على `SHOPIFY_WEBHOOK_SECRET`** — بعد ما كل الصفوف الجديدة تبقى `extra.signedWith = "client_secret"` وويبهوك الـ Admin-UI يتمسح من شوبيفاي: يتشال الـ candidate التاني من `§HELPERS::verifyWebhookSignature`، ويتشال السر من الداشبورد ومن `wrangler.toml`، ويترفع الـ Worker لـ `v2.5.0`.
1. **`scan_capped` مش مسجّلة في `ecommoda-constants` §7** — الجدول هناك بيقول ٤ قيم للأداة دي (`checked_clear` · `duplicate_found` · `hmac_failed` · `skipped`)، والكود المنشور بيكتب `scan_capped` كمان من قبل النقل. **مخالفة موروثة لـ Rule 7، مش ناتجة عن التعديل ده** — تتسجّل في §7 عند أول تحديث للثوابت.
2. **تسجيل `login`/`logout`** — الواجهة الجديدة فيها شاشة دخول، والأداة مابتسجّلش الدخول في D1 (القيمتين مش مسجّلتين في §7). لو اتقرر تسجيله: تتسجّل القيمتين في §7 **الأول**، وبعدين يترجّع `writeLog` في `§AUTH` ويترفع `WORKER_VERSION`.
3. **`DUPLICATE_NOTE_PREFIX` في `wrangler.toml`** — لازم يتكتب قبل ربط الريبو (فوق).

آخر تحديث: 13-09-2026

</div>
