# 🚀 SKMovies — Fojik Source Architecture & Working Mechanism (A to Z Guide)

এই ডকুমেন্টে **Fojik.site** সোর্সের সম্পুর্ণ টেকনিক্যাল আর্কিটেকচার, অটোমেশন, ক্যাশিং প্রসেস, গিটহাব ব্যবহারের সুনির্দিষ্ট কারণ, ওয়ার্কার ফেইলার ইস্যু এবং ভবিষ্যতে একই নিয়মে নতুন সাইট যুক্ত করার গাইডলাইন বিস্তারিত দেওয়া হলো।

---

## 🏗️ 1. Overall System Architecture

SKMovies অ্যাপটি ৩-স্তরের (3-Tier) হাইব্রিড আর্কিটেকচার অনুসরণ করে:

```
[Frontend: app.js / Cloudflare Pages]
              │
              ▼
  [Cloudflare Worker APIs]
        │              │
        ▼              ▼
{GitHub Cache}   [Live Fojik Scraper API]
 (Cache Hit)       (Cache Miss / Fallback)
                       │
                       ▼
                 [Fojik.site]

 [ /api/fojik/download Worker ]
               │
               ▼
 [Form POST: search.technews24.site]
               │
               ▼
 [Direct Google Drive / FastServer Link]
```

1. **Frontend (Browser UI):** `public/app.js` থেকে ব্যবহারকারী মুভি লিস্ট, ফিল্টার, পোস্টার, স্ক্রিনশট এবং ডাউনলোড/প্লে বাটন দেখতে পান।
2. **Cloudflare Worker API Layer (`/api/...`):** 
   - `/api/cache?src=fojik` → ক্যাশ থেকে ডাটা পরিবেশন করে।
   - `/api/fojik/list` → ক্যাশে না থাকলে সরাসরি সার্চ/লিস্ট লাইভ আনে।
   - `/api/fojik/movie` → ক্যাশে না থাকলে লাইভ মুভি ডিটেইলস আনবে।
   - `/api/fojik/download` → `FU` ও `FN` টোকেন পোস্ট করে সরাসরি ডাউনলোড লিঙ্ক বের করে।
3. **GitHub Mega-Cache (`skmovies-cache`):** Cloudflare Datacenter IP ব্লক এড়াতে সমস্ত লিস্ট পেজ এবং মুভি ডিটেইলস JSON ফাইলের আকারে গিটহাবে ক্যাশ হিসেবে থাকে।

---

## 🛑 2. ক্যান গিটহাব ক্যাশ ব্যবহার করতে হলো? (Exact Worker Limitations & Issues)

ক্লাউডফ্লেয়ার ওয়ার্কার (Cloudflare Worker) থাকা সত্ত্বেও কেন সরাসরি ফেস (live fetch) না করে গিটহাব ক্যাশ ব্যবহার করতে হলো, তার মূল টেকনিক্যাল ইস্যুসমূহ নিচে দেওয়া হলো:

### ❌ Issue 1: Cloudflare-to-Cloudflare WAF IP Block (403 Forbidden / Challenge)
- **কারণ:** Fojik.site নিজেও Cloudflare Security Shield / WAF এর পেছনে অবস্থিত।
- **সমস্যা:** ক্লাউডফ্লেয়ার ওয়ার্কার যখন `fetch('https://fojik.site/')` রিকোয়েস্ট পাঠায়, রিকোয়েস্টটি Cloudflare-এর নিজস্ব Datacenter IP থেকে তৈরি হয়।
- Fojik-এর WAF কনফিগারেশনে সমস্ত Datacenter ASN / Cloudflare Worker IP ব্লক করা থাকে। ফলে ওয়ার্কার থেকে রিকোয়েস্ট করলেই **`403 Forbidden`** অথবা **Cloudflare Turnstile Captcha Challenge** রিটার্ন করে, যা সার্ভার-সাইড ওয়ার্কার সলভ করতে পারে না।

### ❌ Issue 2: WordPress REST API Blocked (`/wp-json/wp/v2/posts` = 403)
- Fojik সাইটটি ওয়ার্ডপ্রেস দ্বারা তৈরি হলেও তারা ওয়ার্ডপ্রেসের স্ট্যান্ডার্ড REST API এনপয়েন্ট সিকিউরিটি প্লাগইন দিয়ে সম্পূর্ণ বন্ধ (Blocked) করে রেখেছে। ফলে API দিয়ে সরাসরি ডাটা নেওয়া অসম্ভব, একমাত্র পথ HTML Scraping।

### ❌ Issue 3: Datacenter vs GitHub Actions Runner Advantage
- Cloudflare Workers-এর IP ব্লক হলেও **GitHub Actions Runner (Microsoft Azure IPs)** ব্লক করা নেই।
- গিটহাব ক্রোন জব Runner একটি নরমাল ইউজার ব্রাউজারের মতোই Fojik সাইটে ঢুকতে পারে। তাই স্ক্র্যাপারটি গিটহাব রানারে চালিয়ে JSON বানিয়ে ক্যাশ রিপোজিটরিতে সেভ রাখা হয়।

### ❌ Issue 4: Memory & Execution Timeout Limits
- ১,৫০০+ মুভির বিশাল ডেটাবেজ Cloudflare KV বা Worker Memory-তে রাখা অত্যন্ত ব্যয়বহুল ও সীমাবোধ তৈরি করে।
- GitHub Raw CDN (`raw.githubusercontent.com`) ব্যবহার করায় আমরা কোনো খরচ ছাড়াই ১,৫০০+ মুভির র ইমেজ, স্ক্রিনশট ও ইনফো একদম ইনস্ট্যান্ট মেগা-স্পিডে ইউজারকে সার্ভ করতে পারছি।

---

## 🔐 3. Fojik Download Security & Token Bypass (`FU` and `FN`)

### Fojik-এর নিজস্ব নিরাপত্তা ব্যবস্থা:
Fojik.site সরাসরি গুগল ড্রাইভ বা সার্ভারের লিংক তাদের HTML পেজে দেয় না। তারা একটি **Form Submission Barrier** ব্যবহার করে:

```html
<form method='post' action='https://search.technews24.site/blog.php' target='_blank'>
   <input type='hidden' name='FU' value='QnVURjN3b2NN... (Base64 Token)'>
   <input type='hidden' name='FN' value='Bhooth Bangla (2026)... (Filename)'>
   <button type='submit'>Download</button>
</form>
```

### ⚡ আমাদের অটোমেটেড বাইপাস মেকানিজম:
1. **Scraper Engine (`populate_fojik_cache.js`):** Fojik পেজ পার্স করে প্রতিটি ডাউনলোডের জন্য `FU` (Base64 Encrypted Token) এবং `FN` (File Title) সংগ্রাহ করে `movie.json`-এ জমা রাখে।
2. **Form Execution (`app.js`):** ইউজার ডাউনলোড বা স্ট্রিম বাটনে চাপ দিলে ব্রাউজারে ডায়নামিক একটি হিডেন `<form>` তৈরি করে `FU` এবং `FN` মানসমূহ দিয়ে `search.technews24.site/blog.php`-এ POST করা হয়।
3. **Automatic Redirect:** এর ফলে Fojik-এর সিকিউরিটি ভেরিফিকেশন পাশ করে ব্যবহারকারী সরাসরি আসল **Google Drive / FastServer / GDFlix / Hubcloud** ডাউনলোড পেজে পৌছে যান।

---

## 📦 4. Mega-Cache Generator & GitHub Automation

### Scraper Engine (`scripts/populate_fojik_cache.js`):
- **Category & Genre Pagination Traversal:** ২১+ টি ক্যাটাগরি (Bollywood, Hollywood, Dual Audio, South Indian, Series ইত্যাদি) থেকে সমস্ত মুভির Slug রিড করে।
- **Robust Regex Parsing:** Single-quote (`'`) এবং Double-quote (`"`) উভয় প্রকারের HTML attributes হ্যান্ডেল করে।
- **Automatic Metadata Extraction:**
  - Full HD Posters (thumbnail suffix `-185x278` রিমুভ করে আসল পিকচার নেওয়া হয়)।
  - High-res Screenshots (`imgforwp.xyz` সিডিএন থেকে)।
  - Genres, IMDb Rating, Release Date & Storyline.
  - Quality badges (1080p, 720p, 480p, HEVC, 4K).

### 🤖 Automation (`.github/workflows/fojik_cache.yml`):
- প্রতি **২ ঘণ্টা পরপর** GitHub Actions Runner স্বয়ংক্রিয়ভাবে Fojik সাইট স্ক্র্যাপ করে নতুন নতুন মুভি ও ক্যাটাগরি আপডেট করে `skmovies-cache` রিপোজিটরিতে কমিক করে দেয়।

---

## 🎬 5. Streaming & Player Integration

1. **In-Page Shielded Player (`iframe-player.html`):**
   - Fojik-এর প্লেয়ার ব্যাকগ্রাউন্ডে পপ-আপ বা অ্যাড পাঠালে তা **Sandboxed Iframe Sandbox** (`allow-scripts allow-same-origin`) দ্বারা ব্লক করা হয়।
2. **Direct Play Resolution:**
   - ডাউনলোড লিঙ্কের সাথে সাথে অনলাইন প্লেয়ার অপশন দেখায়।
   - ইউজার চাইলে প্লেয়ার সুইচার দিয়ে HDPlayer অথবা In-Page Player বেছে নিতে পারেন।

---

## 🛠️ 6. ভবিষ্যতে একই নিয়মে নতুন মুভি/আইপিটিভি সাইট যুক্ত করার স্টেপ-বাই-স্টেপ গাইড

নতুন কোনো সাইট (যেমন: `newsite.com`) এই আর্কিটেকচারে যুক্ত করতে নিচের ৪টি ধাপ অনুসরণ করতে হবে:

### Step 1: Create Scraper Script
`scripts/populate_newsite_cache.js` ফাইল তৈরি করুন যা টার্গেট সাইট স্ক্র্যাপ করে JSON তৈরি করবে এবং `skmovies-cache-repo/newsite/` ফোল্ডারে সেভ করবে:
- `latest.json`, `latest-2.json`... (লিস্টের জন্য)
- `movie/<slug>.json` (মুভি ডিটেইলসের জন্য)

### Step 2: Create API Endpoints
`functions/api/newsite/` ফোল্ডারে ২টি ফাইল যোগ করুন:
1. `list.js` → গিটহাব ক্যাশ রিড করবে, মিস হলে লাইভ ফেচ করবে।
2. `movie.js` → মুভি ডিটেইলস ক্যাশ রিড করবে, মিস হলে লাইভ পার্স করবে।

### Step 3: Register in Frontend (`public/app.js`)
`app.js`-এর `getApi()` ফাংশনে নতুন সোর্সটি রেজিস্টার করুন:
```javascript
if (src === 'newsite') {
  return {
    latest: buildCacheApi('latest'),
    movie: buildCacheApi('movie'),
    search: '/api/newsite/list?type=search',
    trending: buildCacheApi('latest'),
    resolve: '/api/resolve',
  };
}
```
এবং সাইট সিলেক্টর UI বা ড্রপডাউনে সোর্স হিসেবে `newsite` যুক্ত করুন।

### Step 4: Add GitHub Automation Workflow
`.github/workflows/newsite_cache.yml` নামে নতুন ওয়ার্কফ্লো তৈরি করুন যা নির্দিষ্ট সময় পর পর অটোমেটিক রান হয়ে `skmovies-cache` রিপোতে পুশ করবে।

---

## 🛠️ Summary of Current Fojik API Endpoints

| Endpoint | Type | Purpose |
|---|---|---|
| `/api/cache?src=fojik&path=latest&page=1` | GET | ক্যাশ থেকে ১ নম্বর পেজের মুভি লিস্ট রিটার্ন করে |
| `/api/cache?src=fojik&path=movie&slug=xyz` | GET | নির্দিষ্ট মুভির সম্পূর্ণ ডিটেইলস (পোস্টার, পিকচার, ফর্ম টোকেন) দেয় |
| `/api/fojik/download?action=...&fu=...&fn=...` | GET/POST | FU+FN টোকেন POST করে রেজলভ করা আসল ডাউনলোড লিঙ্ক দেয় |

---
*Created by Antigravity AI for SKMovies Premium System.*
