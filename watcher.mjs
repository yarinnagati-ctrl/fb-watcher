// ===== סוכן 3 — התראה לטלפון על כל תגובה חדשה בקבוצת פייסבוק =====
// גולש בקבוצה עם חשבון פייסבוק משני, עובר על הפוסטים האחרונים,
// ועל כל תגובה חדשה שולח התראה לאפליקציית ntfy בטלפון.
//
// הפעלה ראשונה (התחברות לחשבון המשני):  node watcher.mjs login
// הפעלה רגילה (רץ ברקע ובודק כל 15 דק'):  node watcher.mjs
// בדיקה אחת והדפסה בלבד, בלי התראות:     node watcher.mjs test

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = {
  GROUP_URL: 'https://www.facebook.com/groups/NAHARIYASALE/',
  GROUP_IDS: ['NAHARIYASALE', '130302107619767'], // שם ומספר הקבוצה — פוסטים מקבוצות אחרות מסוננים
  NTFY_TOPIC: process.env.NTFY_TOPIC || 'fb-alerts-826ea64b7ee6',
  INTERVAL_MIN: 15,        // כל כמה דקות לבדוק
  JITTER_MIN: 3,           // תוספת/הפחתה אקראית כדי לא להיראות כמו רובוט
  POSTS_TO_CHECK: 10,      // כמה פוסטים אחרונים לבדוק בכל סבב
  MAX_ALERTS_PER_ROUND: 20,
  QUIET_HOURS: [1, 7],     // לא בודקים בין 01:00 ל־07:00 (שומר על החשבון). [] = בלי שעות שקט
};

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(DIR, 'profile');
const STATE_FILE = path.join(DIR, 'seen.json');
const mode = process.argv[2] || 'run';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const log = (...a) => console.log(new Date().toLocaleString('he-IL'), ...a);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { initialized: false, seen: [], loginAlertSent: false }; }
}
function saveState(s) {
  s.seen = s.seen.slice(-5000);
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}

async function push(title, message, link) {
  const data = { topic: CONFIG.NTFY_TOPIC, title: title.slice(0, 200), message: (message || ' ').slice(0, 1000) };
  if (link) { data.click = link; data.actions = [{ action: 'view', label: 'פתח בפייסבוק', url: link }]; }
  try {
    await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  } catch (e) { log('שליחת התראה נכשלה:', e.message); }
}

async function openBrowser(headless) {
  // בענן (גיטהאב): בלי פרופיל שמור — טוענים את העוגיות של פייסבוק מהסוד FB_COOKIES
  if (process.env.FB_COOKIES) {
    const browser = await chromium.launch({ channel: 'chrome', headless: false,
      args: ['--disable-blink-features=AutomationControlled', '--headless=new', '--no-sandbox'] });
    const ctx = await browser.newContext({ locale: 'he-IL', timezoneId: 'Asia/Jerusalem', viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
    await ctx.addCookies(JSON.parse(process.env.FB_COOKIES));
    ctx.on('close', () => browser.close().catch(() => {}));
    return ctx;
  }
  return chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,   // מצב נסתר אמיתי מופעל דרך הדגל למטה (פחות מזוהה)
    locale: 'he-IL',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', ...(headless ? ['--headless=new'] : [])],
  });
}

async function isLoggedOut(page) {
  return /\/login|checkpoint/.test(page.url()) || (await page.locator('input[name="email"]').count()) > 0;
}

// אוסף קישורים לפוסטים האחרונים בקבוצה
async function getPostLinks(page) {
  await page.goto(CONFIG.GROUP_URL + '?sorting_setting=CHRONOLOGICAL', { waitUntil: 'domcontentloaded' });
  await sleep(rand(4000, 7000));
  if (await isLoggedOut(page)) return null;

  const links = new Map();
  for (let i = 0; i < 8 && links.size < CONFIG.POSTS_TO_CHECK; i++) {
    // ריחוף על קישורי הזמן חושף את הכתובת האמיתית של הפוסט
    // ריחוף רק על קישורי הזמן ("3 שעות", "אתמול"...) — הם חושפים את כתובת הפוסט
    const anchors = page.locator('div[role="feed"] a[role="link"]');
    const n = Math.min(await anchors.count(), 300);
    for (let j = 0; j < n && links.size < CONFIG.POSTS_TO_CHECK; j++) {
      const a = anchors.nth(j);
      let href = await a.getAttribute('href').catch(() => null);
      if (href && !/\/posts\/|\/permalink\//.test(href)) {
        const txt = ((await a.textContent({ timeout: 300 }).catch(() => '')) || '').trim();
        if (txt.length > 25 || !/\d|אתמול|עכשיו|דק|שע|יום|ימים|Yesterday|Just now|min|hr|[0-9]h/.test(txt)) continue;
        await a.hover({ timeout: 700 }).catch(() => {});
        href = await a.getAttribute('href').catch(() => null);
      }
      const m = href && href.match(/groups\/([^/?#]+)\/(?:posts|permalink)\/(\d+)/);
      if (m && CONFIG.GROUP_IDS.includes(m[1]) && !links.has(m[2])) links.set(m[2], `https://www.facebook.com/groups/${m[1]}/posts/${m[2]}/`);
    }
    await page.mouse.wheel(0, rand(1200, 2200));
    await sleep(rand(2000, 4000));
  }
  return [...links.values()];
}

// מנסה להציג את כל התגובות לפי החדשות ביותר
async function showAllComments(page) {
  const sortBtn = page.getByText(/^(הרלוונטיות ביותר|הכי רלוונטיות|Most relevant)$/).first();
  if (await sortBtn.count()) {
    await sortBtn.click({ timeout: 3000 }).catch(() => {});
    await sleep(rand(800, 1500));
    const opt = page.getByText(/^(החדשות ביותר|הכי חדשות|Newest|כל התגובות|All comments)$/).first();
    if (await opt.count()) await opt.click({ timeout: 3000 }).catch(() => {});
    await sleep(rand(1500, 2500));
  }
  for (let i = 0; i < 3; i++) {
    const more = page.getByText(/^(הצג(ת)? עוד תגובות|הצגת תגובות קודמות|View more comments|View previous comments)/).first();
    if (!(await more.count())) break;
    await more.click({ timeout: 3000 }).catch(() => {});
    await sleep(rand(1500, 2500));
  }
}

async function getComments(page, postUrl) {
  await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
  await sleep(rand(3500, 6000));
  await showAllComments(page);
  return page.$$eval('div[role="article"][aria-label]', (els, postUrl) => els.map(el => {
    const label = el.getAttribute('aria-label') || '';
    if (!/תגובה|השיב|השיבה|Comment|Reply/i.test(label)) return null;
    let m = label.match(/^(?:תגובה|תשובה) של (.+?)(?: לתגובה של .+?)?(?: לפני .*| ב.*)?$/)
         || label.match(/^(?:Comment|Reply) by (.+?)(?: to .+?)?(?: \d.*| (?:a|an) .*ago)?$/i);
    let author = m ? m[1].trim() : '';
    if (!author) {
      const a = [...el.querySelectorAll('a[role="link"]')].find(x => x.textContent.trim() && /\/user\/|profile/.test(x.getAttribute('href') || ''));
      author = a ? a.textContent.trim() : '';
    }
    const isReply = /^(תשובה|Reply)/i.test(label);
    const text = [...el.querySelectorAll('div[dir="auto"]')].map(d => d.textContent.trim()).filter(Boolean)
      .filter((t, i, arr) => arr.indexOf(t) === i).join(' ');
    let id = '', link = postUrl;
    for (const a of el.querySelectorAll('a[href*="comment_id="]')) {
      const h = a.getAttribute('href');
      const r = h.match(/reply_comment_id=(\d+)/), c = h.match(/comment_id=(\d+)/);
      id = (r || c)[1];
      link = postUrl + '?comment_id=' + c[1] + (r ? '&reply_comment_id=' + r[1] : '');
      break;
    }
    if (!id) id = 'h:' + postUrl + '|' + author + '|' + text.slice(0, 80);
    return { id, author, text, link, isReply };
  }).filter(Boolean), postUrl);
}

function inQuietHours() {
  const [from, to] = CONFIG.QUIET_HOURS;
  if (from === undefined) return false;
  const h = new Date().getHours();
  return from < to ? h >= from && h < to : h >= from || h < to;
}

async function round({ dryRun = false } = {}) {
  const state = loadState();
  const seen = new Set(state.seen);
  const ctx = await openBrowser(true);
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    const posts = await getPostLinks(page);
    if (posts === null) {
      log('החשבון לא מחובר לפייסבוק.');
      if (!state.loginAlertSent && !dryRun) {
        await push('⚠️ סוכן 3 נותק מפייסבוק', 'צריך להתחבר מחדש: node watcher.mjs login', '');
        state.loginAlertSent = true; saveState(state);
      }
      return;
    }
    state.loginAlertSent = false;
    log(`נמצאו ${posts.length} פוסטים`);
    const fresh = [];
    for (const url of posts) {
      const comments = await getComments(page, url).catch(e => { log('שגיאה בפוסט', url, e.message); return []; });
      log(`  ${url} — ${comments.length} תגובות`);
      for (const c of comments) if (!seen.has(c.id)) { seen.add(c.id); fresh.push(c); }
      await sleep(rand(3000, 8000));
    }
    if (dryRun) { fresh.forEach(c => log(`[${c.author}] ${c.text.slice(0, 120)}  ${c.link}`)); return; }
    if (state.initialized) {
      for (const c of fresh.slice(0, CONFIG.MAX_ALERTS_PER_ROUND)) {
        await push('💬 תגובה חדשה בקבוצה', c.text || 'לחץ כדי לפתוח את הפוסט', c.link);
        await sleep(500);
      }
      if (fresh.length > CONFIG.MAX_ALERTS_PER_ROUND)
        await push('💬 ועוד תגובות', `עוד ${fresh.length - CONFIG.MAX_ALERTS_PER_ROUND} תגובות חדשות בקבוצה`, CONFIG.GROUP_URL);
      log(`נשלחו התראות על ${fresh.length} תגובות חדשות`);
    } else {
      state.initialized = true;
      log(`סבב ראשון: נשמרו ${fresh.length} תגובות קיימות בלי התראה`);
      await push('סוכן 3 פעיל ✅', `עוקב אחרי הקבוצה. מעכשיו תקבל התראה על כל תגובה חדשה (בדיקה כל ${CONFIG.INTERVAL_MIN} דק').`, CONFIG.GROUP_URL);
    }
    state.seen = [...seen];
    saveState(state);
  } finally {
    await ctx.close();
  }
}

if (mode === 'login') {
  const ctx = await openBrowser(false);
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.facebook.com/');
  console.log('\nהתחבר בחלון שנפתח עם החשבון המשני, וודא שהוא חבר בקבוצה.\nבסיום — סגור את החלון.\n');
  await new Promise(r => { ctx.on('close', r); page.on('close', r); });
  await ctx.close().catch(() => {});
} else if (mode === 'cookies') {
  // מייצא את העוגיות של פייסבוק מהפרופיל המקומי — להדבקה בסוד FB_COOKIES בגיטהאב
  const ctx = await openBrowser(true);
  const cookies = (await ctx.cookies('https://www.facebook.com')).map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) =>
    ({ name, value, domain, path, expires, httpOnly, secure, sameSite }));
  await ctx.close();
  fs.writeFileSync(path.join(DIR, 'סודי-עוגיות-פייסבוק.txt'), JSON.stringify(cookies));
  console.log('נשמרו', cookies.length, 'עוגיות. מחובר:', cookies.some(c => c.name === 'c_user'));
} else if (mode === 'once') {
  // סבב אחד (לגיטהאב)
  if (inQuietHours()) log('שעות שקט — מדלג');
  else await round();
} else if (mode === 'test') {
  await round({ dryRun: true });
} else {
  log('סוכן 3 התחיל לרוץ');
  for (;;) {
    if (inQuietHours()) log('שעות שקט — מדלג');
    else await round().catch(e => log('שגיאה בסבב:', e.message));
    const min = CONFIG.INTERVAL_MIN + rand(-CONFIG.JITTER_MIN, CONFIG.JITTER_MIN);
    await sleep(min * 60 * 1000);
  }
}
