# 🚀 SKMovies Deploy Pack — এক ক্লিকে ডিপ্লয় করুন

এই প্যাকেজে সব কোড + সব ডকুমেন্টেশন একসাথে আছে। ৩০ মিনিটের মধ্যে আপনার নিজস্ব SKMovies instance live হয়ে যাবে।

---

## 📦 প্যাকেজে যা আছে

```
skmovies-deploy-pack/
├── README.md                          ← মূল প্রজেক্ট README
├── DEPLOY.md                          ← এই ফাইল (ডিপ্লয়মেন্ট গাইড)
├── REVERSE-ENGINEERING.md             ← API contract ডকুমেন্ট
│
├── frontend/                          ← প্রোডাকশন frontend (Cloudflare Pages-এ live ভার্সন)
│   ├── index.html
│   ├── app.js                         ← v3.3.8 (110 KB)
│   ├── styles.css                     ← v3.3.8 (69 KB)
│   ├── manifest.json
│   └── assets/                        ← favicon + icons
│
├── frontend-premium-src/              ← অল্টারনেট ভার্সন (premium look)
│
├── backend/                           ← Cloudflare Pages Functions
│   ├── package.json
│   ├── wrangler.toml
│   ├── _routes.json
│   └── functions/api/
│       ├── latest.js                  ← MLSBD latest movies
│       ├── trending.js                ← trending widget
│       ├── search.js                  ← search
│       ├── category.js                ← category listing
│       ├── south.js                   ← south-Indian
│       ├── movie.js                   ← movie detail + download links
│       ├── resolve.js                 ← savelinks.me resolver
│       ├── img.js                     ← image proxy (CORS bypass)
│       ├── proxy.js                   ← generic CORS proxy
│       ├── notice.js                  ← curated notices
│       └── fdm/                       ← FreeDriveMovie source (6 files)
│
├── api-samples/                       ← live API response samples
│
├── deploy.sh                          ← one-click deploy script
├── dev.sh                             ← local dev script
│
└── (ডকুমেন্টেশন)
    ├── HDHUB4U-ISSUE-FIX-PLAN.md      ← HDHub4u issue analysis
    ├── HDHUB4U-NOCARD-FIX.md          ← no-card fix
    ├── HDHUB4U-WORKERS-403-FIX.md     ← 403 fix (Deno proxy architecture)
    ├── MKV-PLAYBACK-FIX-PLAN.md       ← MKV playback fix
    ├── FIBWATCH-ANALYSIS.md           ← FIBWatch reverse-engineering
    └── skmovies-hdhub4u-issue-and-fix-plan.md
```

---

## 🎯 ৩টি ডিপ্লয়মেন্ট অপশন

### ✅ অপশন A: Cloudflare Pages (ফ্রি, সবচেয়ে recommended)

**সময়:** ১০–১৫ মিনিট | **খরচ:** $0

#### ধাপ ১: Prerequisites install
```bash
# Node.js 18+ লাগবে
node --version  # v18 বা তার উপরে

# Wrangler install করুন
npm install -g wrangler
```

#### ধাপ ২: Code প্রস্তুত করুন
```bash
# Zip থেকে extract করুন
unzip skmovies-deploy-pack.zip
cd skmovies-deploy-pack

# backend ফোল্ডারে যান
cd backend

# Frontend assets backend root-এ copy করুন
cp -r ../frontend/* .
cp -r ../frontend-premium-src ./frontend-premium-src  # optional
```

#### ধাপ ৩: Cloudflare লগইন + ডিপ্লয়
```bash
# Cloudflare তে লগইন (browser খুলবে)
npx wrangler login

# নতুন Pages project তৈরি করুন
npx wrangler pages project create skmovies-premium

# ডিপ্লয় করুন!
npx wrangler pages deploy . --project-name skmovies-premium
```

#### ধাপ ৪: ভেরিফাই করুন
ডিপ্লয় শেষে একটি URL পাবেন যেমন:
```
https://skmovies-premium.pages.dev
```

টেস্ট করুন:
- `https://skmovies-premium.pages.dev/api/latest?page=1` → JSON আসবে
- `https://skmovies-premium.pages.dev/` → frontend দেখাবে

---

### ✅ অপশন B: Vercel (ফ্রি, সহজ)

```bash
# Vercel CLI install
npm install -g vercel

# প্রজেক্ট ফোল্ডারে যান
cd skmovies-deploy-pack/backend
cp -r ../frontend/* .

# ডিপ্লয়
vercel --prod
```

> ⚠️ নোট: Vercel-এ Pages Functions-এর জায়গায় Serverless Functions লাগে। `vercel.json` এ রাউট রিরাইট করতে হবে।

---

### ✅ অপশন C: লোকাল ডেভ (টেস্টিং)

```bash
cd skmovies-deploy-pack/backend
cp -r ../frontend/* .
npm install
npx wrangler pages dev . --port 8788

# খুলুন: http://localhost:8788/
```

---

## 🔧 কনফিগারেশন (ঐচ্ছিক)

### KV Namespace (notice override এর জন্য)
```bash
# KV namespace তৈরি
npx wrangler kv:namespace create NOTICES_KV

# wrangler.toml-এ যোগ করুন:
# [[kv_namespaces]]
# binding = "NOTICES_KV"
# id = "<আপনার KV namespace ID>"
```

### Custom Domain
Cloudflare Dashboard → Pages → আপনার প্রজেক্ট → Custom domains → Add domain

---

## 🛠️ HDHub4u 403 Fix (আলাদাভাবে ডিপ্লয় করতে হবে)

HDHub4u endpoint-গুলো Cloudflare Workers-এ কাজ করে না (BIC block করে)। জন্য একটি Deno Deploy proxy লাগবে। বিস্তারিত এই ফাইলে:
- **`HDHUB4U-WORKERS-403-FIX.md`** — পুরো architecture + code

সংক্ষেপে:
```bash
# Deno Deploy-তে ডিপ্লয় করুন
curl -fsSL https://deno.land/x/install/install.sh | sh
deno install -Arf jsr:@deno/deployctl

# proxy.ts ডিপ্লয় করুন (HDHUB4U-WORKERS-403-FIX.md-এ code আছে)
deployctl deploy --project=skmovies-hdhub4u-proxy proxy.ts
```

তারপর Cloudflare Pages-এর environment variable সেট করুন:
```
HDHUB4U_PROXY_URL=https://skmovies-hdhub4u-proxy.deno.dev
```

---

## 📋 Endpoint Reference

| Endpoint | Method | কাজ |
|----------|--------|-----|
| `/api/latest?page=1&filter=all` | GET | MLSBD latest |
| `/api/trending` | GET | trending widget |
| `/api/notice` | GET | notices |
| `/api/search?q=hindi&page=1` | GET | search |
| `/api/category?slug=hindi-dubbed-movies&page=1` | GET | category |
| `/api/south?hindi=1&page=1` | GET | south-Indian |
| `/api/movie?slug=<slug>` | GET | movie detail |
| `/api/resolve?url=<savelinks-url>` | GET | resolve to file-host |
| `/api/img?u=<base64\|url>` | GET | image proxy |
| `/api/proxy?u=<base64url>` | GET | generic proxy |
| `/api/fdm/*` | GET | FreeDriveMovie source |

---

## ❓ সমস্যা হলে

### `wrangler login` কাজ করে না
Browser খুলে https://dash.cloudflare.com → Workers & Pages → সেখান থেকে API token নিন।
```bash
export CLOUDFLARE_API_TOKEN=your_token_here
npx wrangler pages deploy .
```

### API 403 দেখাচ্ছে
- HDHub4u → `HDHUB4U-WORKERS-403-FIX.md` পড়ুন
- MLSBD → User-Agent চেক করুন, বা `cf-connecting-ip` header যোগ করুন

### Frontend খোলে না
- `_routes.json` ঠিক আছে কিনা চেক করুন
- `frontend/*` ঠিকমতো `backend/`-তে copy হয়েছে কিনা দেখুন

### MKV play হচ্ছে না
- `MKV-PLAYBACK-FIX-PLAN.md` পড়ুন — Remux বা HLS conversion লাগতে পারে

---

## ⚖️ Disclaimer

এই প্যাকেজ **শিক্ষামূলক ও ব্যক্তিগত archival** উদ্দেশ্যে। Upstream source-গুলো (`mlsbd.co`, `freedrivemovie.cyou`, `savelinks.me`, `hdhub4u.med`) user-submitted লিংক host করে, কিছু copyright-protected content-এর হতে পারে। Backend কোড শুধু publicly accessible HTML re-parse করে — কোনো authentication, paywall, বা DRM bypass করে না।

ডিপ্লয়ের আগে আপনার দেশের copyright আইন মেনে নিন।

---

## 📞 Support

- সমস্যা: GitHub issues (যদি থাকে)
- ডকুমেন্টেশন: এই প্যাকেজের সব `.md` ফাইল পড়ুন
- Quick start: `./deploy.sh` চালান (নিচে দেখুন)
