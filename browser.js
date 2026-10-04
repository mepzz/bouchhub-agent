// browser.js — Opens a separate minimized Chrome window using a copy of the user's profile
// This preserves all existing Chrome tabs and uses saved logins/cookies
const { chromium } = require('playwright-core');
const { exec, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DEBUG_PORT = 9222;
const BOUCHHUB_PROFILE = path.join(os.homedir(), 'AppData', 'Local', 'BouchHubProfile');

let activeBrowser = null;
let activePage = null;

// ─── Find a Chromium browser ───────────────────────────────
// Chrome, Brave or Edge: all three are Chromium and take the same
// remote-debugging flags, so whichever is installed drives the searches.
// BROWSER_PATH in the agent's .env pins one. `userData` is where that
// browser keeps the user's real profile (its cookies are copied so the
// BouchHub window is already logged in).
const LOCAL = path.join(os.homedir(), 'AppData', 'Local');
const BROWSERS = [
  { name: 'Chrome', exe: [path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'], userData: path.join(LOCAL, 'Google', 'Chrome', 'User Data') },
  { name: 'Brave', exe: [path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'], userData: path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data') },
  { name: 'Edge', exe: [path.join(LOCAL, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'], userData: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data') },
];
function findBrowser() {
  const pinned = process.env.BROWSER_PATH;
  if (pinned) {
    try { fs.accessSync(pinned); } catch (_) { throw new Error(`BROWSER_PATH points at ${pinned} but nothing is there`); }
    const known = BROWSERS.find((b) => b.exe.some((e) => e.toLowerCase() === pinned.toLowerCase()) || new RegExp(b.name, 'i').test(pinned));
    return { name: known ? known.name : 'browser', path: pinned, userData: known ? known.userData : null };
  }
  for (const b of BROWSERS) {
    for (const exe of b.exe) {
      try { fs.accessSync(exe); return { name: b.name, path: exe, userData: b.userData }; } catch (_) {}
    }
  }
  return null;
}
function findChrome() { const b = findBrowser(); return b ? b.path : null; }   // back-compat

// ─── Check debug port ──────────────────────────────────────
async function isDebugPortOpen() {
  try {
    const fetch = require('node-fetch');
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { timeout: 1500 });
    return r.ok;
  } catch (_) { return false; }
}

// ─── Sync cookies from real Chrome profile ────────────────
// Copies only the login/session files, not the full profile (which is huge)
function syncProfileFromChrome(userData) {
  const realProfile = path.join(userData || path.join(LOCAL, 'Google', 'Chrome', 'User Data'), 'Default');
  const bouchhubDefault = path.join(BOUCHHUB_PROFILE, 'Default');

  if (!fs.existsSync(BOUCHHUB_PROFILE)) {
    fs.mkdirSync(BOUCHHUB_PROFILE, { recursive: true });
    fs.mkdirSync(bouchhubDefault, { recursive: true });
  }

  // Files that carry login sessions and saved passwords
  const filesToCopy = ['Cookies', 'Login Data', 'Login Data For Account', 'Web Data', 'Preferences', 'Secure Preferences'];

  for (const file of filesToCopy) {
    const src = path.join(realProfile, file);
    const dst = path.join(bouchhubDefault, file);
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    } catch (_) {
      // File might be locked — that's OK, skip it
    }
  }

  console.log('[Browser] Profile synced from Chrome');
}

// ─── Launch BouchHub Chrome window ────────────────────────
async function launchBrowser() {
  if (activeBrowser) return { browser: activeBrowser, page: activePage };

  // Try connecting to existing BouchHub debug session
  if (await isDebugPortOpen()) {
    console.log('[Browser] Reconnecting to existing BouchHub Chrome window');
    activeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`, { timeout: 5000 });
  } else {
    const browser = findBrowser();
    if (!browser) throw new Error('No Chromium browser found (looked for Chrome, Brave and Edge in the usual places). Install one, or set BROWSER_PATH in the agent .env to its exe.');
    const chromePath = browser.path;

    // Sync cookies from the real profile so we're already logged in
    if (browser.userData) syncProfileFromChrome(browser.userData);

    const args = [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--remote-debugging-address=127.0.0.1`,
      `--user-data-dir="${BOUCHHUB_PROFILE}"`,
      '--new-window',
      '--start-minimized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-notifications',
      '--disable-blink-features=AutomationControlled',
    ].join(' ');

    console.log(`[Browser] Opening BouchHub ${browser.name} window (minimized, separate from your tabs): ${chromePath}`);
    exec(`"${chromePath}" ${args}`);

    // Wait for debug port to be ready
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isDebugPortOpen()) {
        console.log(`[Browser] BouchHub ${browser.name} ready`);
        break;
      }
      if (i === 19) throw new Error('Chrome opened but debug port never became available.');
    }

    activeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`, { timeout: 10000 });
    console.log('[Browser] Connected — your existing Chrome tabs are untouched');
  }

  activeBrowser.on('disconnected', () => {
    activeBrowser = null;
    activePage = null;
    console.log('[Browser] BouchHub Chrome disconnected');
  });

  // Get or open a page in the BouchHub window
  const contexts = activeBrowser.contexts();
  if (contexts.length > 0 && contexts[0].pages().length > 0) {
    activePage = contexts[0].pages()[0];
  } else {
    const ctx = contexts.length > 0 ? contexts[0] : await activeBrowser.newContext();
    activePage = await ctx.newPage();
  }

  return { browser: activeBrowser, page: activePage };
}

// ─── Close BouchHub window only ────────────────────────────
async function closeBrowser() {
  if (activeBrowser) {
    try {
      // Close all pages in our context, then disconnect
      const contexts = activeBrowser.contexts();
      for (const ctx of contexts) {
        for (const page of ctx.pages()) {
          try { await page.close(); } catch (_) {}
        }
      }
      await activeBrowser.close();
    } catch (_) {}
    activeBrowser = null;
    activePage = null;
  }
}

// ─── Navigate ──────────────────────────────────────────────
async function navigate(url) {
  const { page } = await launchBrowser();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return { url: page.url(), title: await page.title() };
}

// ─── Marketplace search ────────────────────────────────────
// Search selling platforms for recent listings and return clean listing cards:
//   [{ id, title, price, url, image, location }]
// Runs in the BouchHub Chrome window, which shares the user's logged-in
// cookies — so Facebook Marketplace works without a separate login. Facebook
// is sorted newest-first; the others default to their recency sort. DOM
// scraping is best-effort and defensive: selectors drift, so we pull from
// anchor hrefs + nearby text rather than brittle class names.

function buildSearchUrl(platform, query, opts = {}) {
  const q = encodeURIComponent(query);
  const max = opts.maxPrice ? Math.ceil(opts.maxPrice) : null;
  switch (platform) {
    case 'facebook': {
      // creation_time_descend = newest first. location slug defaults to the
      // account's own area when omitted, which is what we want.
      const loc = opts.fbLocation || '';
      const params = [`query=${q}`, 'sortBy=creation_time_descend'];
      if (max) params.push(`maxPrice=${max}`);
      if (opts.radiusKm) params.push(`radius=${Math.round(opts.radiusKm * 1000)}`);
      return `https://www.facebook.com/marketplace/${loc ? loc + '/' : ''}search?${params.join('&')}`;
    }
    case 'kijiji':
      // Kijiji Canada full-text search, sorted by date (newest).
      return `https://www.kijiji.ca/b-buy-sell/canada/${q}/k0c10l0?sort=dateDesc${max ? `&price=__${max}` : ''}`;
    case 'ebay': {
      // eBay.ca, sorted newest (_sop=10), CAD site. opts.sold = completed +
      // sold items only, most recent sale first (_sop=13) — the hub's "what
      // did this actually sell for" comps. opts.minPrice weeds out lots of
      // commons when hunting one card.
      // opts.perPage (60 | 120 | 240) and opts.page let the hub sweep a whole
      // search ("every live Senators Future Watch auto"), not just the newest 40.
      const min = opts.minPrice ? Math.floor(opts.minPrice) : null;
      // opts.sort 'ending' = auctions ending soonest (_sop=1); opts.auction = auctions only.
      const sold = opts.sold ? '&LH_Sold=1&LH_Complete=1&_sop=13' : (opts.sort === 'ending' ? '&_sop=1' : '&_sop=10');
      const perPage = [60, 120, 240].includes(Number(opts.perPage)) ? Number(opts.perPage) : null;
      const pageNo = Number(opts.page) > 1 ? Math.floor(Number(opts.page)) : null;
      return `https://www.ebay.ca/sch/i.html?_nkw=${q}${sold}${max ? `&_udhi=${max}` : ''}${min ? `&_udlo=${min}` : ''}${opts.buyItNow ? '&LH_BIN=1' : ''}${opts.auction ? '&LH_Auction=1' : ''}${perPage ? `&_ipg=${perPage}` : ''}${pageNo ? `&_pgn=${pageNo}` : ''}`;
    }
    // ── Retail / online stores (new + open-box) ──
    case 'amazon':          return `https://www.amazon.ca/s?k=${q}`;
    case 'bestbuy':         return `https://www.bestbuy.ca/en-ca/search?search=${q}`;
    case 'walmart':         return `https://www.walmart.ca/en/search?q=${q}`;
    case 'newegg':          return `https://www.newegg.ca/p/pl?d=${q}`;
    case 'staples':         return `https://www.staples.ca/search?query=${q}`;
    case 'canadacomputers': return `https://www.canadacomputers.com/en/search?s=${q}`;
    case 'ebgames':         return `https://www.ebgames.ca/search?q=${q}`;
    case 'brand':
      // The item's own brand store — the hub passes a full search URL it built
      // from the parsed brand (opts.brandUrl). No generic fallback.
      if (!opts.brandUrl) throw new Error('brand platform needs opts.brandUrl');
      return opts.brandUrl;
    default:
      throw new Error(`unknown platform: ${platform}`);
  }
}

// Platforms whose results we read with the generic retail extractor below.
const RETAIL_PLATFORMS = ['amazon', 'bestbuy', 'walmart', 'newegg', 'staples', 'canadacomputers', 'ebgames', 'brand'];

async function marketplaceSearch(platform, query, opts = {}) {
  const { page } = await launchBrowser();
  const url = buildSearchUrl(platform, query, opts);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  // Listings hydrate client-side; give them a moment and nudge lazy loaders.
  await page.waitForTimeout(3500);
  try { await page.mouse.wheel(0, 2400); await page.waitForTimeout(1500); } catch (_) {}

  const isRetail = RETAIL_PLATFORMS.includes(platform);
  // opts.limit caps the items returned (default 40, up to 240 for a sweep).
  const limit = Math.max(1, Math.min(240, Number(opts.limit) || 40));
  const items = await page.evaluate(({ platform, isRetail, limit }) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const priceFrom = txt => {
      const m = clean(txt).match(/\$[\d,]+(?:\.\d{2})?/);
      return m ? parseFloat(m[0].replace(/[$,]/g, '')) : null;
    };
    const out = [];
    const seen = new Set();

    // ── Generic retail extractor ──
    // Retail layouts vary wildly, so read structured data first: most stores
    // embed schema.org Product/ItemList JSON-LD. Fall back to a DOM heuristic
    // (a product-link anchor with a nearby price + image).
    if (isRetail) {
      const push = (o) => {
        const id = `${platform}_` + (o.url || o.title).replace(/[^\w]/g, '').slice(-40);
        if (!o.title || seen.has(id)) return;
        seen.add(id);
        out.push({ id, title: o.title, price: o.price ?? null, url: o.url || location.href, image: o.image || null, location: null });
      };
      // 1) JSON-LD
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        let data; try { data = JSON.parse(s.textContent); } catch { continue; }
        const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (const n of nodes) {
          const items2 = n && n.itemListElement ? n.itemListElement.map(e => e.item || e) : (n && n['@type'] === 'Product' ? [n] : []);
          for (const p of items2) {
            if (!p || !(p.name || p.title)) continue;
            const offers = Array.isArray(p.offers) ? p.offers[0] : p.offers;
            push({
              title: clean(p.name || p.title),
              price: offers && offers.price ? parseFloat(offers.price) : priceFrom(JSON.stringify(offers || '')),
              url: typeof p.url === 'string' ? (p.url.startsWith('http') ? p.url : location.origin + p.url) : location.href,
              image: Array.isArray(p.image) ? p.image[0] : (typeof p.image === 'string' ? p.image : (p.image && p.image.url)),
            });
          }
        }
      }
      // 2) DOM heuristic fallback
      if (out.length < 3) {
        const anchors = [...document.querySelectorAll('a[href]')].filter(a => {
          const t = clean(a.innerText);
          return t.length > 15 && /\$\d/.test(a.closest('li,div,article')?.innerText || '');
        });
        for (const a of anchors.slice(0, 60)) {
          const card = a.closest('li, article, div[data-item], div[class*="product"], div[class*="Product"]') || a;
          const img = card.querySelector('img');
          const href = a.getAttribute('href') || '';
          push({
            title: clean(a.innerText).split('\n')[0],
            price: priceFrom(card.innerText),
            url: href.startsWith('http') ? href : location.origin + href,
            image: img ? (img.src || img.getAttribute('data-src') || img.getAttribute('srcset')?.split(' ')[0]) : null,
          });
        }
      }
      return out.slice(0, 40);
    }

    if (platform === 'facebook') {
      for (const a of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
        const m = a.getAttribute('href').match(/\/marketplace\/item\/(\d+)/);
        if (!m || seen.has(m[1])) continue;
        const text = clean(a.innerText);
        if (!text) continue;
        const img = a.querySelector('img');
        // FB card text is usually "$price\nTitle\nLocation"
        const lines = text.split('\n').map(clean).filter(Boolean);
        const price = priceFrom(text);
        const title = lines.find(l => !l.startsWith('$')) || text;
        seen.add(m[1]);
        out.push({ id: 'fb_' + m[1], title, price, url: 'https://www.facebook.com/marketplace/item/' + m[1], image: img ? img.src : null, location: lines[lines.length - 1] || null });
      }
    } else if (platform === 'kijiji') {
      for (const a of document.querySelectorAll('a[data-testid="listing-link"], a[href*="/v-"]')) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/(\d{7,})(?:\?|$|\/)/) || href.match(/-(\d{7,})$/);
        const id = m ? m[1] : href;
        if (!id || seen.has(id)) continue;
        const card = a.closest('[data-testid="listing-card"], li, article') || a;
        const title = clean(a.innerText) || clean(card.querySelector('h3, [class*="title"]')?.innerText);
        if (!title) continue;
        const img = card.querySelector('img');
        seen.add(id);
        out.push({ id: 'kj_' + id, title, price: priceFrom(card.innerText), url: href.startsWith('http') ? href : 'https://www.kijiji.ca' + href, image: img ? (img.src || img.getAttribute('data-src')) : null, location: null });
      }
    } else if (platform === 'ebay') {
      for (const li of document.querySelectorAll('li.s-item, li[data-viewport]')) {
        const a = li.querySelector('a.s-item__link, a[href*="/itm/"]');
        if (!a) continue;
        const m = (a.getAttribute('href') || '').match(/\/itm\/(\d+)/);
        const id = m ? m[1] : null;
        if (!id || seen.has(id)) continue;
        const title = clean(li.querySelector('.s-item__title, [role="heading"]')?.innerText);
        if (!title || /shop on ebay/i.test(title)) continue;
        const img = li.querySelector('img');
        seen.add(id);
        // A sold listing shows when it sold ("Sold Sep 20, 2026") and whether
        // it went by auction or best offer; a live one its format and shipping.
        const tag = clean(li.querySelector('.s-item__title--tagblock, .s-item__ended-date, .s-item__caption, .s-item__title-tag')?.innerText) || null;
        const soldAt = tag && /sold/i.test(tag) ? tag.replace(/^sold\s*/i, '').trim() : null;
        const text = clean(li.innerText);
        // Auctions: "6d 3h left" / "2h 15m left" and the bid count; a fixed
        // price shows "Buy It Now" / "or Best Offer" instead.
        // The "time left" span first; the end-date span ("(Sat, 07:45 PM)")
        // only as a last resort, and then the text itself: "6d 3h left",
        // "Ends in 6d 3h", or a bare "6d 3h" / "2h 15m" in the new card layout.
        const SPAN = /\b(\d+\s*d(?:\s*\d+\s*h)?|\d+\s*h(?:\s*\d+\s*m)?|\d+\s*m(?:\s*\d+\s*s)?)\b/i;
        const timeLeft = clean(li.querySelector('.s-item__time-left, .s-card__time-left, [class*="time-left"]')?.innerText)
          || (text.match(/\b(\d+d\s*\d*h?|\d+h\s*\d*m?|\d+m\s*\d*s?)\s*left\b/i) || [null])[0]
          || (text.match(/\bends?\s*in\s*:?\s*(\d+d(?:\s*\d+h)?|\d+h(?:\s*\d+m)?|\d+m(?:\s*\d+s)?)/i) || [null])[0]
          || (text.match(/\b(\d+d\s+\d+h|\d+h\s+\d+m|\d+m\s+\d+s)\b/i) || [null])[0]
          || (SPAN.test(clean(li.querySelector('.s-item__time-end')?.innerText) || '') ? clean(li.querySelector('.s-item__time-end').innerText) : null)
          || null;
        const bidsText = clean(li.querySelector('.s-item__bids, .s-item__bidCount')?.innerText) || (text.match(/\b(\d+)\s*bids?\b/i) || [null])[0];
        const bids = bidsText ? parseInt(bidsText, 10) : null;
        out.push({
          id: 'eb_' + id, title, price: priceFrom(li.querySelector('.s-item__price')?.innerText || li.innerText),
          url: 'https://www.ebay.ca/itm/' + id, image: img ? (img.src || img.getAttribute('data-src')) : null, location: null,
          soldAt, bestOffer: /best offer/i.test(text), buyItNow: /buy it now/i.test(text),
          auction: !!timeLeft || (bids != null && !/buy it now/i.test(text)),
          timeLeft: timeLeft ? timeLeft.replace(/\s*left\s*$/i, '').trim() : null, bids,
          shipping: (text.match(/(\$[\d,]+(?:\.\d{2})?\s*shipping|free shipping)/i) || [null])[0],
        });
      }
    }
    return out.slice(0, limit);
  }, { platform, isRetail, limit });

  return { platform, url, count: items.length, items };
}

// Fetch the readable text of a single item/product page (for link parsing).
async function extractPage(url) {
  const { page } = await launchBrowser();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const og = p => document.querySelector(`meta[property="og:${p}"]`)?.content || null;
    return {
      url: location.href,
      title: clean(document.title),
      ogTitle: og('title'),
      ogPrice: document.querySelector('meta[property="product:price:amount"]')?.content
            || document.querySelector('meta[property="og:price:amount"]')?.content || null,
      ogImage: og('image'),
      // First ~4000 chars of visible text is plenty for Claude to parse.
      text: clean(document.body ? document.body.innerText : '').slice(0, 4000),
    };
  });
}

// ─── Instagram Login ───────────────────────────────────────
async function instagramLogin(username, password) {
  const { page } = await launchBrowser();
  await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  if (!page.url().includes('accounts/login')) {
    return { success: true, message: 'Already logged in via synced Chrome cookies' };
  }

  if (!username || !password) {
    return { success: false, message: 'Not logged in. Add INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD to agent .env, or log in manually to Chrome first.' };
  }

  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle' });
  await page.waitForSelector('input[name="username"]', { timeout: 15000 });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.waitForTimeout(700);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);

  // Handle 2FA — wait up to 90s
  if (page.url().includes('challenge') || page.url().includes('two_factor')) {
    console.log('[Browser] 2FA detected — BouchHub Chrome window will become visible for you to complete it');
    // Can't make it truly visible from here, but it's minimized not hidden
    // User can click it in taskbar
    try {
      await page.waitForURL('**/instagram.com/**', { timeout: 90000 });
    } catch (_) {
      return { success: false, message: '2FA timeout. Click the BouchHub Chrome window in your taskbar to complete it.' };
    }
  }

  for (let i = 0; i < 2; i++) {
    try {
      const btn = await page.$('button:has-text("Not Now"), button:has-text("Not now")');
      if (btn) { await btn.click(); await page.waitForTimeout(1500); }
    } catch (_) {}
  }

  return page.url().includes('login')
    ? { success: false, message: 'Login failed — check credentials' }
    : { success: true, message: 'Logged in successfully' };
}

// ─── Instagram DM ──────────────────────────────────────────
async function instagramSendDM(recipientUsername, message) {
  const { page } = await launchBrowser();

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (page.url().includes('accounts/login')) {
    const u = process.env.INSTAGRAM_USERNAME;
    const p = process.env.INSTAGRAM_PASSWORD;
    const result = await instagramLogin(u, p);
    if (!result.success) throw new Error(result.message);
  }

  // Navigate to DMs using domcontentloaded — networkidle never fires on Instagram
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Click the compose/new message button
  try {
    const composeBtn = await page.waitForSelector(
      'svg[aria-label="New message"], a[href="/direct/new/"], button[title="New message"]',
      { timeout: 8000 }
    );
    await composeBtn.click();
    await page.waitForTimeout(2000);
  } catch (_) {
    // Try navigating directly
    await page.goto('https://www.instagram.com/direct/new/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  // Search for recipient — try multiple selectors with fallback
  const searchSelectors = [
    'input[placeholder="Search..."]',
    'input[placeholder*="Search"]',
    'input[name="queryBox"]',
    '[role="dialog"] input[type="text"]',
    '[role="dialog"] input',
    'input[type="text"]',
  ];

  let searchInput = null;
  for (const sel of searchSelectors) {
    try {
      searchInput = await page.waitForSelector(sel, { timeout: 4000 });
      if (searchInput) { console.log(`[Browser] Found search input via: ${sel}`); break; }
    } catch (_) {}
  }

  if (!searchInput) {
    // Save a screenshot so we can inspect what's actually on screen
    try {
      const snap = await page.screenshot({ type: 'jpeg', quality: 70 });
      require('fs').writeFileSync(require('path').join(require('os').homedir(), 'bouchhub_dm_modal_debug.jpg'), snap);
      console.log('[Browser] Debug screenshot saved to ~/bouchhub_dm_modal_debug.jpg');
    } catch (_) {}
    throw new Error('Could not find DM search input — Instagram DOM may have changed. Check bouchhub_dm_modal_debug.jpg on the agent machine.');
  }

  await searchInput.click();
  await page.waitForTimeout(500);
  await searchInput.type(recipientUsername, { delay: 100 });
  await page.waitForTimeout(3000);

  // Click first result — try multiple selectors
  const resultSelectors = [
    'div[role="listbox"] div[role="option"]',
    'div[role="option"]',
    '[role="listbox"] > div',
    'div[role="listbox"] > div > div',
  ];

  let clicked = false;
  for (const sel of resultSelectors) {
    try {
      const result = await page.waitForSelector(sel, { timeout: 4000 });
      if (result) { await result.click(); clicked = true; console.log(`[Browser] Clicked recipient via: ${sel}`); break; }
    } catch (_) {}
  }

  if (!clicked) {
    try {
      const snap = await page.screenshot({ type: 'jpeg', quality: 70 });
      require('fs').writeFileSync(require('path').join(require('os').homedir(), 'bouchhub_dm_results_debug.jpg'), snap);
      console.log('[Browser] Debug screenshot saved to ~/bouchhub_dm_results_debug.jpg');
    } catch (_) {}
    throw new Error(`Could not find Instagram user: ${recipientUsername}. They may not follow you, or the username is wrong. Check bouchhub_dm_results_debug.jpg.`);
  }

  await page.waitForTimeout(1000);

  // Click Next/Chat button
  const nextSelectors = [
    'button:has-text("Next")',
    'button:has-text("Chat")',
    'div[role="button"]:has-text("Next")',
    'div[role="button"]:has-text("Chat")',
    '[role="dialog"] button[type="button"]:last-of-type',
  ];

  for (const sel of nextSelectors) {
    try {
      const next = await page.waitForSelector(sel, { timeout: 3000 });
      if (next) { await next.click(); console.log(`[Browser] Clicked Next via: ${sel}`); break; }
    } catch (_) {}
  }

  await page.waitForTimeout(3000);

  // Type and send message
  const msgBoxSelectors = [
    'div[aria-label="Message"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea[placeholder]',
    'textarea',
  ];

  let msgBox = null;
  for (const sel of msgBoxSelectors) {
    try {
      msgBox = await page.waitForSelector(sel, { timeout: 4000 });
      if (msgBox) { console.log(`[Browser] Found message box via: ${sel}`); break; }
    } catch (_) {}
  }

  if (!msgBox) throw new Error('Could not find message input box after opening DM thread.');

  await msgBox.click();
  await page.waitForTimeout(300);
  await msgBox.type(message, { delay: 60 });
  await page.waitForTimeout(500 + Math.random() * 300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  // Do NOT close the browser here — caller may send more DMs sequentially.
  // Hub should send a browser_close action after all DMs are done.
  return { success: true, message: `Message sent to @${recipientUsername}` };
}

// ─── Utils ─────────────────────────────────────────────────
async function getPageInfo() {
  if (!activePage) return { url: null, title: null };
  try { return { url: activePage.url(), title: await activePage.title() }; }
  catch (_) { return { url: null, title: null }; }
}

async function screenshot() {
  if (!activePage) return null;
  try {
    return (await activePage.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
  } catch (_) { return null; }
}

// ─── One thing at a time on the tab ────────────────────────
// Everything above drives the single BouchHub tab. Two navigations landing
// on it together abort each other ("page.goto: net::ERR_ABORTED"), which is
// what the hub's card hunter did when its check, its ending-soon pass and
// its reminder tick all asked at once. Each tab-driving entry point waits
// its turn here; a failure never blocks the next caller.
let _turn = Promise.resolve();
function serial(fn) {
  return (...args) => {
    const run = _turn.then(() => fn(...args), () => fn(...args));
    _turn = run.catch(() => {});
    return run;
  };
}

module.exports = {
  launchBrowser, closeBrowser, navigate: serial(navigate),
  instagramLogin: serial(instagramLogin), instagramSendDM: serial(instagramSendDM),
  marketplaceSearch: serial(marketplaceSearch), extractPage: serial(extractPage), buildSearchUrl, findBrowser, BROWSERS,
  getPageInfo, screenshot,
  isOpen: () => !!activeBrowser,
};
