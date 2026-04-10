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

// ─── Find Chrome ───────────────────────────────────────────
function findChrome() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c); return c; } catch (_) {}
  }
  return null;
}

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
function syncProfileFromChrome() {
  const realProfile = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default');
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
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found. Please install Google Chrome.');

    // Sync cookies from real profile so we're already logged in
    syncProfileFromChrome();

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

    console.log('[Browser] Opening BouchHub Chrome window (minimized, separate from your tabs)...');
    exec(`"${chromePath}" ${args}`);

    // Wait for debug port to be ready
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isDebugPortOpen()) {
        console.log('[Browser] BouchHub Chrome ready');
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

module.exports = {
  launchBrowser, closeBrowser, navigate,
  instagramLogin, instagramSendDM,
  getPageInfo, screenshot,
  isOpen: () => !!activeBrowser,
};
