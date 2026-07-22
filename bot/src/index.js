/**
 * SKMovies Telegram Bot — Cloudflare Worker
 * Premium bot with commands, inline keyboards, image banner, auto-setup.
 */

const TG_API = 'https://api.telegram.org/bot';

const COMMANDS = [
  { command: 'start', description: '🚀 Start / welcome message' },
  { command: 'help', description: '❓ Help & commands list' },
  { command: 'latest', description: '🎬 Latest movies' },
  { command: 'search', description: '🔍 Search — /search <query>' },
  { command: 'favs', description: '⭐ Your watchlist' },
  { command: 'history', description: '🕐 Recently viewed' },
  { command: 'stats', description: '📊 Download stats' },
  { command: 'settings', description: '⚙️ Settings' },
  { command: 'request', description: '📝 Request a movie' },
  { command: 'miniapp', description: '📱 Open Mini App' },
];

const BOT_NAME = 'SKMovies Premium Bot';
const BOT_DESC = '🎬 Premium ad-free movie streamer. Browse, search, play in your favorite external player. Pixel-perfect clone of mlsbd.co.';
const BOT_SHORT_DESC = '🎬 Premium movie streamer (mlsbd.co clone)';

function getPagesUrl(env) {
  return (env.PAGES_URL || 'https://skmovies-premium.pages.dev').replace(/\/+$/, '');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    // ─── /setup — one-shot bot setup ─────────────────────────────────
    if (url.pathname === '/setup') {
      return handleSetup(url, env);
    }

    // ─── /webhook — Telegram updates ─────────────────────────────────
    if (url.pathname === '/webhook') {
      return handleWebhook(request, env);
    }

    // ─── /health ─────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        service: 'skmovies-bot',
        version: '1.0.1',
        timestamp: new Date().toISOString(),
        bot_token: !!env.BOT_TOKEN,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ─── / — status page ─────────────────────────────────────────────
    const pagesUrl = getPagesUrl(env);
    return new Response(
      `🎬 SKMovies Telegram Bot v1.0.1\n\n` +
      `Status: ${env.BOT_TOKEN ? '✅ BOT_TOKEN set' : '❌ BOT_TOKEN missing'}\n\n` +
      `Setup: https://${url.host}/setup?token=<BOT_TOKEN>&webhook=1\n` +
      `Webhook: https://${url.host}/webhook\n` +
      `Mini App: ${pagesUrl}/\n`,
      { headers: { 'Content-Type': 'text/plain' } }
    );
  },
};

// ─── Setup ───────────────────────────────────────────────────────────
async function handleSetup(url, env) {
  const token = url.searchParams.get('token') || env.BOT_TOKEN;
  if (!token) return new Response('Missing BOT_TOKEN. Pass ?token=<TOKEN> or set BOT_TOKEN secret.', { status: 401 });

  const host = url.host;
  const webhookUrl = `https://${host}/webhook`;
  const pagesUrl = getPagesUrl(env);
  const webAppUrl = `${pagesUrl}/`;
  const results = {};

  // 1. setMyCommands
  results.commands = await tgCall(token, 'setMyCommands', { commands: COMMANDS });

  // 2. setMyName
  results.name = await tgCall(token, 'setMyName', { name: BOT_NAME });

  // 3. setMyDescription
  results.description = await tgCall(token, 'setMyDescription', { description: BOT_DESC });

  // 4. setMyShortDescription
  results.short_description = await tgCall(token, 'setMyShortDescription', { description: BOT_SHORT_DESC });

  // 5. setChatMenuButton → Mini App
  results.menu_button = await tgCall(token, 'setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: '🎬 Open SKMovies',
      web_app: { url: webAppUrl },
    },
  });

  // 6. setWebhook (if requested)
  if (url.searchParams.get('webhook') === '1') {
    const params = { url: webhookUrl, max_connections: 40, allowed_updates: ['message', 'callback_query', 'inline_query'] };
    if (env.WEBHOOK_SECRET) params.secret_token = env.WEBHOOK_SECRET;
    results.webhook = await tgCall(token, 'setWebhook', params);
  }

  // 7. getMe (bot info)
  results.bot_info = await tgCall(token, 'getMe', {});

  return new Response(JSON.stringify({
    ok: true,
    webAppUrl,
    webhookUrl,
    results,
    next_steps: [
      `1. Open your bot: @${results.bot_info?.ok ? results.bot_info.result.username : '<bot-username>'}`,
      `2. Tap the menu button (☰) → Mini App opens`,
      `3. Or send /start to see welcome message`,
    ],
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Webhook handler ─────────────────────────────────────────────────
async function handleWebhook(request, env) {
  const token = env.BOT_TOKEN;
  if (!token) return new Response('BOT_TOKEN not set', { status: 500 });

  let update;
  try { update = await request.json(); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  const pagesUrl = getPagesUrl(env);

  // ─── Message ──────────────────────────────────────────────────────
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || '';

    if (text.startsWith('/start')) {
      await sendStart(token, chatId, pagesUrl);
    } else if (text.startsWith('/help')) {
      await sendHelp(token, chatId, pagesUrl);
    } else if (text.startsWith('/latest')) {
      await sendLatest(token, chatId, pagesUrl);
    } else if (text.startsWith('/search ')) {
      const query = text.slice('/search '.length).trim();
      await sendSearch(token, chatId, query, pagesUrl);
    } else if (text.startsWith('/favs')) {
      await sendMessage(token, chatId, '⭐ Watchlist feature available in the Mini App. Tap the menu button.');
    } else if (text.startsWith('/history')) {
      await sendMessage(token, chatId, '🕐 History feature available in the Mini App. Tap the menu button.');
    } else if (text.startsWith('/stats')) {
      await sendMessage(token, chatId, '📊 Stats feature available in the Mini App. Tap the menu button.');
    } else if (text.startsWith('/settings')) {
      await sendSettings(token, chatId, pagesUrl);
    } else if (text.startsWith('/request ')) {
      const name = text.slice('/request '.length).trim();
      await sendMessage(token, chatId, `📝 আপনার request "${name}" গ্রহণ করা হয়েছে\\!`, { parse_mode: 'MarkdownV2' });
    } else if (text.startsWith('/miniapp')) {
      await sendMiniApp(token, chatId, pagesUrl);
    } else if (text.trim()) {
      // Treat as search
      await sendSearch(token, chatId, text.trim(), pagesUrl);
    }
  }

  // ─── Callback query ───────────────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || '';
    const chatId = cq.message?.chat?.id;

    await answerCallback(token, cq.id);

    if (data === 'open_miniapp') {
      await sendMiniApp(token, chatId, pagesUrl);
    } else if (data === 'latest') {
      await sendLatest(token, chatId, pagesUrl);
    } else if (data === 'help') {
      await sendHelp(token, chatId, pagesUrl);
    } else if (data === 'settings') {
      await sendSettings(token, chatId, pagesUrl);
    } else if (data === 'start') {
      await sendStart(token, chatId, pagesUrl);
    } else if (data.startsWith('movie:')) {
      const slug = data.split(':')[1];
      await sendMovieLink(token, chatId, slug, pagesUrl);
    }
  }

  return new Response('OK');
}

// ─── Bot message handlers ────────────────────────────────────────────
async function sendStart(token, chatId, pagesUrl) {
  const text =
    `👋 *Welcome to SKMovies Premium\\!*\n\n` +
    `🎬 আমি তোমার personal premium movie assistant\\.\n\n` +
    `✨ *Premium Features:*\n` +
    `${"✅"} Pixel\\-perfect clone of mlsbd\\.co\n` +
    `${"✅"} Ad\\-free experience\n` +
    `${"✅"} Direct stream \\(MX Player, VLC, Just Player, MPV\\)\n` +
    `${"✅"} Premium badges \\(4K, HDR, HEVC, Netflix, etc\\.\\)\n` +
    `${"✅"} External player detection \\(PC / Android / iOS\\)\n\n` +
    `📋 *Commands:*\n` +
    `${"🔹"} /latest \\- latest movies\n` +
    `${"🔹"} /search <query> \\- search movies\n` +
    `${"🔹"} /help \\- help message\n` +
    `${"🔹"} /miniapp \\- open Mini App\n\n` +
    `🚀 Tap the menu button \\(☰\\) to open the Mini App\\!`;

  const keyboard = [
    [
      { text: '🎬 Latest Movies', callback_data: 'latest' },
      { text: '📱 Mini App', callback_data: 'open_miniapp' },
    ],
    [
      { text: '❓ Help', callback_data: 'help' },
      { text: '⚙️ Settings', callback_data: 'settings' },
    ],
  ];

  const bannerUrl = `${pagesUrl}/assets/og-image.webp`;

  // Try sending banner photo first
  try {
    const r = await fetch(`${TG_API}${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: bannerUrl,
        caption: text,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
    if (r.ok) return;
  } catch {}

  await sendMessage(token, chatId, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendHelp(token, chatId, pagesUrl) {
  const text =
    `📖 *SKMovies Premium Bot — Help*\n\n` +
    `*Commands:*\n\n` +
    `🎬 /latest \\- Latest movies\n` +
    `🔍 /search <query> \\- Search movies\n` +
    `⭐ /favs \\- Your watchlist \\(in Mini App\\)\n` +
    `🕐 /history \\- Recently viewed \\(in Mini App\\)\n` +
    `📊 /stats \\- Download stats \\(in Mini App\\)\n` +
    `⚙️ /settings \\- Bot settings\n` +
    `📝 /request <name> \\- Request a movie\n` +
    `📱 /miniapp \\- Open Mini App\n` +
    `❓ /help \\- This message\n\n` +
    `*Mini App:*\n` +
    `Tap the menu button \\(☰\\) in chat to open the full SKMovies web app\\.\n\n` +
    `*Player Support:*\n` +
    `📱 Android: MX Player, VLC, Just Player, MPV\n` +
    `🍎 iOS: VLC, Infuse, PlayerXtreme\n` +
    `🖥️ Windows: VLC, PotPlayer, MPV\n` +
    `🍏 macOS: IINA, VLC, MPV`;

  await sendMessage(token, chatId, text, {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'start' }]] },
  });
}

async function sendSettings(token, chatId, pagesUrl) {
  const text =
    `⚙️ *Settings*\n\n` +
    `📱 *Mini App:* ${pagesUrl}/\n` +
    `🌐 *Website:* ${pagesUrl}\n` +
    `🎬 *Source:* mlsbd\\.co \\(cloned\\)\n` +
    `🚫 *Ads:* Removed\n\n` +
    `আরও অপশন শীঘ্রই আসছে\\!`;

  await sendMessage(token, chatId, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: [[{ text: '🏠 Home', callback_data: 'start' }]] },
  });
}

async function sendMiniApp(token, chatId, pagesUrl) {
  await sendMessage(token, chatId, `📱 Mini App খুলতে নিচের button চাপুন:`, {
    reply_markup: {
      inline_keyboard: [[{ text: '🎬 Open SKMovies', web_app: { url: `${pagesUrl}/` } }]],
    },
  });
}

async function sendLatest(token, chatId, pagesUrl) {
  try {
    const r = await fetch(`${pagesUrl}/api/latest?page=1`);
    const data = await r.json();
    if (!data.ok || !data.items || data.items.length === 0) {
      await sendMessage(token, chatId, '❌ কোনো movie পাওয়া যায়নি। পরে চেষ্টা করো।');
      return;
    }
    const items = data.items.slice(0, 8);
    const keyboard = items.map((m) => [{
      text: `🎬 ${m.title.slice(0, 50)}`,
      callback_data: `movie:${m.slug}`,
    }]);
    keyboard.push([{ text: '📱 Open in Mini App', web_app: { url: `${pagesUrl}/` } }]);
    await sendMessage(token, chatId, `🎬 *Latest Movies* \\(${data.items.length}\\)\\!`, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (e) {
    await sendMessage(token, chatId, `❌ Error: ${e.message}`);
  }
}

async function sendSearch(token, chatId, query, pagesUrl) {
  try {
    const r = await fetch(`${pagesUrl}/api/search?q=${encodeURIComponent(query)}`);
    const data = await r.json();
    if (!data.ok || !data.items || data.items.length === 0) {
      await sendMessage(token, chatId, `❌ "${query}" এর জন্য কোনো movie পাওয়া যায়নি`);
      return;
    }
    const items = data.items.slice(0, 10);
    const keyboard = items.map((m) => [{
      text: `🎬 ${m.title.slice(0, 50)}`,
      callback_data: `movie:${m.slug}`,
    }]);
    keyboard.push([{ text: '📱 Open in Mini App', web_app: { url: `${pagesUrl}/` } }]);
    await sendMessage(token, chatId, `🔍 *Search results for "${query}"* \\(${data.items.length}\\)`, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (e) {
    await sendMessage(token, chatId, `❌ Error: ${e.message}`);
  }
}

async function sendMovieLink(token, chatId, slug, pagesUrl) {
  const url = `${pagesUrl}/?movie=${slug}`;
  await sendMessage(token, chatId, `🎬 Movie details দেখতে নিচের button চাপুন:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎬 Open Movie', web_app: { url } }],
        [{ text: '🏠 Home', callback_data: 'start' }],
      ],
    },
  });
}

// ─── Telegram API helpers ────────────────────────────────────────────
async function tgCall(token, method, body) {
  try {
    const r = await fetch(`${TG_API}${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

async function sendMessage(token, chatId, text, extra = {}) {
  return tgCall(token, 'sendMessage', { chat_id: chatId, text, ...extra });
}

async function answerCallback(token, callbackQueryId, text = '') {
  return tgCall(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}
