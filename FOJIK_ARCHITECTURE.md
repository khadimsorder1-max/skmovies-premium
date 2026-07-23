# 🚀 SKMovies — Fojik Source Architecture & Working Mechanism (A to Z Guide)

এই ডকুমেন্টে **Fojik.site** সোর্সের সম্পুর্ণ টেকনিক্যাল আর্কিটেকচার, অটোমেশন, ক্যাশিং প্রসেস, ফর্ম টোকেন বাইপাস এবং ডাইরেক্ট ডাউনলোড ও স্ট্রিমিং মেকানিজম সংক্ষেপে ব্যাখ্যা করা হলো।

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

## 🔐 2. Fojik Download Security & Token Bypass (`FU` and `FN`)

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

## 📦 3. Mega-Cache Generator & GitHub Automation

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

## 🎬 4. Streaming & Player Integration

1. **In-Page Shielded Player (`iframe-player.html`):**
   - Fojik-এর প্লেয়ার ব্যাকগ্রাউন্ডে পপ-আপ বা অ্যাড পাঠালে তা **Sandboxed Iframe Sandbox** (`allow-scripts allow-same-origin`) দ্বারা ব্লক করা হয়।
2. **Direct Play Resolution:**
   - ডাউনলোড লিঙ্কের সাথে সাথে অনলাইন প্লেয়ার অপশন দেখায়।
   - ইউজার চাইলে প্লেয়ার সুইচার দিয়ে HDPlayer অথবা In-Page Player বেছে নিতে পারেন।

---

## 🛠️ Summary of API Endpoints

| Endpoint | Type | Purpose |
|---|---|---|
| `/api/cache?src=fojik&path=latest&page=1` | GET | ক্যাশ থেকে ১ নম্বর পেজের মুভি লিস্ট রিটার্ন করে |
| `/api/cache?src=fojik&path=movie&slug=xyz` | GET | নির্দিষ্ট মুভির সম্পূর্ণ ডিটেইলস (পোস্টার, পিকচার, ফর্ম টোকেন) দেয় |
| `/api/fojik/download?action=...&fu=...&fn=...` | GET/POST | FU+FN টোকেন POST করে রেজলভ করা আসল ডাউনলোড লিঙ্ক দেয় |

---
*Created by Antigravity AI for SKMovies Premium System.*
