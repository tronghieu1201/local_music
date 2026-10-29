const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/giapt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js');

const root = __dirname;
const outputDir = path.join(root, 'artifacts', 'navigation-review');
fs.mkdirSync(outputDir, { recursive: true });
const rows = [1, 2].map(index => ({ $id: `sample-${index}`, fileId: `file-${index}`, filename: `SoundKer${index}.mp3`, title: `SoundKer${index}`, size: 123000, folders: ['Tiktok'], active: true }));
const sdk = `(() => {
  const rows = ${JSON.stringify(rows)};
  class Client { setEndpoint(){return this;} setProject(){return this;} }
  class Account { async get(){const e=new Error('Unauthenticated local sample');e.code=401;throw e;} }
  class TablesDB { async listRows(){return {rows,total:rows.length};} }
  class Storage { async listFiles(){return {files:[],total:0};} }
  class Functions { async createExecution(options){const body=JSON.parse(options.body);if(body.action!=='get-playback-url')throw new Error('Mutations blocked in visual QA');return new Promise(()=>{});} }
  window.Appwrite={Client,Account,TablesDB,Storage,Functions,ID:{unique:()=> 'local-only'},Query:{limit:n=>'limit('+n+')',offset:n=>'offset('+n+')'},ExecutionMethod:{POST:'POST'}};
})();`;
const iconStub = `
function init(){
const icons = {'login-icon-container':'M10 17l5-5-5-5M15 12H3M14 3h5v18h-5','logout-icon-container':'M14 17l5-5-5-5M19 12H7M10 3H5v18h5','mobile-refresh-icon-container':'M20 11a8 8 0 1 0-2 7M20 4v7h-7','mobile-info-icon-container':'M12 11v6M12 7v1','prev-icon-container':'M18 5v14L7 12zM5 5v14','next-icon-container':'M6 5v14l11-7zM19 5v14'};
for(const [id,d] of Object.entries(icons)){const el=document.getElementById(id);if(el)el.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20" aria-hidden="true"><path d="'+d+'"></path></svg>';}
window.LocalSoundIcons={setPlaying(){},setMuted(){},setLoopMode(){}};
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();`;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const filePath = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
});

const checks = [];
const issues = [];
let browser;
const record = (name, value) => checks.push({ name, value });

async function screenshot(page, name) {
  await page.locator('#toast-container').evaluate(el => el.replaceChildren());
  await page.screenshot({ path: path.join(outputDir, name + '.png'), fullPage: false });
}

async function menuMetrics(page) {
  return page.locator('#mobile-discovery-category-menu').evaluate(el => {
    const styles = getComputedStyle(el);
    const bounds = el.getBoundingClientRect();
    const row = el.querySelector('[data-category="tiktok"]');
    return { background: styles.backgroundColor, opacity: styles.opacity, filter: styles.filter, backdrop: styles.backdropFilter, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom }, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, rowClass: row?.className, rowChecked: row?.getAttribute('aria-checked'), rowCurrent: row?.getAttribute('aria-current'), rowText: row?.innerText, count: row?.querySelector('.mobile-discovery-category-count')?.textContent, rowBackground: row ? getComputedStyle(row).backgroundColor : '' };
  });
}

async function runCase(width, theme) {
  const mobile = width <= 768;
  const height = width === 320 ? 568 : mobile ? 844 : 900;
  const caseId = `${width}-${theme}`;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, colorScheme: theme });
  const page = await context.newPage();
  const pageErrors = [];
  const remoteBlocked = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await context.addInitScript(({ theme }) => {
    localStorage.setItem('localsound-desktop-theme', theme);
    localStorage.setItem('localsound-temporary-data-notice-snooze-until', String(Date.now() + 100000000));
    HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.load = function () {};
  }, { theme });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') {
      if (url.pathname === '/src/icons.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: iconStub });
      return route.continue();
    }
    remoteBlocked.push(`${route.request().method()} ${url.hostname}${url.pathname}`);
    if ((url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'unpkg.com') && url.pathname.includes('appwrite')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: sdk });
    if (url.hostname === 'sgp.cloud.appwrite.io') return route.fulfill({ status: 206, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Range': 'bytes 0-0/1', 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' }, body: Buffer.alloc(0) });
    return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('tiktok-count')?.textContent === '2');
    assert.equal(await page.locator('#auth-login-btn').isVisible(), false, 'Login button hidden before opening settings');
    assert.equal(await page.locator('.top-header #auth-controls').count(), 0, 'No header auth controls');
    record(caseId + ' initial-header', await page.locator('.top-header').evaluate(el => ({ width: el.getBoundingClientRect().width, scrollWidth: document.documentElement.scrollWidth, innerWidth: innerWidth })));

    if (mobile) {
      await page.locator('#mobile-discovery-category').click();
      assert.equal(await page.locator('#mobile-discovery-category-menu').isVisible(), true);
      let metrics = await menuMetrics(page);
      assert.equal(metrics.opacity, '1', 'Category menu is opaque');
      assert.match(metrics.background, /^rgb\(/, 'Category menu background has no alpha');
      assert.ok(metrics.bounds.x >= 0 && metrics.bounds.right <= width, 'Menu fits horizontal viewport');
      assert.ok(metrics.bounds.bottom < height - 60, 'Menu stays above bottom navigation');
      assert.equal(metrics.count, '2');
      record(caseId + ' menu', metrics);
      await screenshot(page, caseId + '-menu');
      await page.locator('[data-category="tiktok"]').click();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#mobile-discovery-category-menu').isVisible(), false, 'Selecting category closes menu');
      assert.equal(await page.locator('#mobile-discovery-category-label').textContent(), 'SoundKer');
      assert.equal(await page.locator('#mobile-discovery-category-icon').isVisible(), true, 'Selected category icon visible');
      const trigger = await page.locator('#mobile-discovery-category').evaluate(el => {
        const icon = el.querySelector('#mobile-discovery-category-icon');
        const bounds = el.getBoundingClientRect();
        return { text: el.innerText, bounds: { x: bounds.x, right: bounds.right, width: bounds.width }, iconClass: icon?.className, iconBackground: icon ? getComputedStyle(icon).backgroundImage : '', iconWidth: icon?.getBoundingClientRect().width, labelWidth: el.querySelector('#mobile-discovery-category-label')?.getBoundingClientRect().width, labelScrollWidth: el.querySelector('#mobile-discovery-category-label')?.scrollWidth };
      });
      assert.match(trigger.iconClass, /icon-tiktok/);
      assert.match(trigger.iconBackground, /leaf\.webp/);
      assert.ok(trigger.bounds.right <= width, 'Trigger fits viewport');
      record(caseId + ' selected', trigger);
      await screenshot(page, caseId + '-selected');
      await page.locator('#mobile-discovery-category').click();
      metrics = await menuMetrics(page);
      assert.ok(/active|selected/.test(metrics.rowClass) || metrics.rowChecked === 'true' || metrics.rowCurrent === 'true', 'Reopened menu marks selected row');
      record(caseId + ' selected-menu', metrics);
      await screenshot(page, caseId + '-selected-menu');
      await page.mouse.click(width - 4, Math.min(height - 100, metrics.bounds.bottom + 15));
      assert.equal(await page.locator('#mobile-discovery-category-menu').isVisible(), false, 'Clicking outside closes menu');
      await page.locator('#mobile-tab-library').click();
      assert.equal(await page.locator('#current-playlist-icon').isVisible(), true, 'Library shows selected folder icon');
      record(caseId + ' library-heading', await page.locator('#current-playlist-heading').evaluate(el => ({ html: el.innerHTML, text: el.innerText, icon: el.previousElementSibling?.className, iconBackground: getComputedStyle(el.previousElementSibling).backgroundImage })));
      await screenshot(page, caseId + '-library');
    } else {
      await page.locator('.sidebar [data-tab="tiktok"]').click();
      assert.equal(await page.locator('#current-playlist-icon').isVisible(), true, 'Library shows selected folder icon');
      record(caseId + ' library-heading', await page.locator('#current-playlist-heading').evaluate(el => ({ html: el.innerHTML, text: el.innerText, icon: el.previousElementSibling?.className, iconBackground: getComputedStyle(el.previousElementSibling).backgroundImage })));
      await screenshot(page, caseId + '-library');
    }

    await page.locator(mobile ? '#mobile-tab-settings' : '#settings-open-btn').click();
    assert.equal(await page.locator('#mobile-settings-modal').isVisible(), true);
    assert.equal(await page.locator('#mobile-settings-modal #auth-controls').count(), 1);
    assert.equal(await page.locator('#auth-login-btn').isVisible(), true);
    const login = await page.locator('#auth-login-btn').evaluate(el => {
      const style = getComputedStyle(el);
      const label = el.querySelector('.btn-label');
      return { text: el.innerText, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, color: style.color, background: style.backgroundColor, labelDisplay: label ? getComputedStyle(label).display : '', parent: el.closest('.modal')?.id };
    });
    assert.match(login.text, /Đăng nhập/);
    assert.notEqual(login.labelDisplay, 'none', 'Login label visible');
    record(caseId + ' settings', login);
    await screenshot(page, caseId + '-settings');
    await page.locator('#auth-login-btn').click();
    await page.waitForTimeout(180);
    assert.equal(await page.locator('#mobile-settings-modal').isVisible(), false, 'Settings closes when login opens');
    assert.equal(await page.locator('#auth-modal').isVisible(), true);
    assert.equal(await page.locator('#admin-email').evaluate(el => el === document.activeElement), true, 'Email receives keyboard focus');
    assert.equal(await page.locator('.modal.active').count(), 1, 'Only one modal is active');
    await screenshot(page, caseId + '-login');
    await page.locator('#close-auth').click();
    assert.equal(await page.locator('#auth-modal').isVisible(), false);
    assert.equal(await page.locator('#auth-login-btn').isVisible(), false, 'Login hides with settings closed');
    record(caseId + ' complete', { pageErrors, remoteRequestsIntercepted: [...new Set(remoteBlocked)], noRemoteRequestContinued: true });
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    issues.push({ caseId, error: error.message, stack: error.stack, pageErrors });
    await screenshot(page, caseId + '-failure').catch(() => {});
  } finally {
    await context.close();
  }
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/giapt/.cache/puppeteer/chrome/win64-151.0.7922.71/chrome-win64/chrome.exe' });
    for (const width of [390, 320, 1280]) for (const theme of ['light', 'dark']) await runCase(width, theme);
    const report = { checks, issues, screenshots: fs.readdirSync(outputDir).filter(name => name.endsWith('.png')) };
    fs.writeFileSync(path.join(outputDir, 'review.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = issues.length ? 1 : 0;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
