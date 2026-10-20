'use strict';
// Run with PLAYWRIGHT_CORE_PATH pointing to an existing playwright-core install.
const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.PREVIEW_SETTINGS;
  const electron = await _electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [path.join(__dirname, 'gallery-test-app.cjs')], env, timeout: 30000 });
  const errors = [];
  electron.on('window', (page) => page.on('pageerror', (err) => errors.push(err.message)));
  const panel = await electron.firstWindow();
  panel.setDefaultTimeout(8000);
  panel.on('pageerror', (err) => errors.push(err.message));
  const bounds = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => ({ url: w.webContents.getURL(), bounds: w.getBounds(), visible: w.isVisible() })));
  const setCursor = (x, y) => electron.evaluate((_, point) => { global.galleryTestCursor = point; }, { x, y });
  try {
    await panel.waitForFunction(() => document.querySelectorAll('.card').length > 0);
    await wait(400);
    let wins = await bounds(), pb = wins.find((w) => w.url.endsWith('/panel.html')).bounds;
    assert.equal(pb.width, 36); assert.equal(pb.height, 76);
    await panel.screenshot({ path: path.join(output, 'gallery-handle.png') });
    await setCursor(pb.x + 10, pb.y + 20);
    // Immediate activation hides the handle during Playwright's post-hover
    // hit-target check, so dispatch the pointer without that redundant check.
    await panel.locator('#handle').hover({ force: true });
    await panel.waitForFunction(() => document.body.classList.contains('expanded'));
    assert.equal((await panel.evaluate(() => window.api.getPanelState())).sticky, false);
    await panel.evaluate(() => window.api.requestExpand(true));
    await panel.waitForFunction(() => document.body.classList.contains('expanded'));
    await wait(300);
    pb = (await bounds()).find((w) => w.url.endsWith('/panel.html')).bounds;
    assert.equal(pb.width, 384);
    await setCursor(pb.x + 100, pb.y + 220);
    const grid = await panel.locator('.card').evaluateAll((els) => els.slice(0, 3).map((el) => ({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight })));
    assert.equal(grid[0].y, grid[1].y); assert(grid[1].x > grid[0].x); assert(grid[2].y > grid[0].y);
    assert(grid[0].height > 130, 'Gallery rows must keep their thumbnail and title height');
    await panel.screenshot({ path: path.join(output, 'gallery-panel.png') });
    console.log('PASS: collapsed handle, native 384px drawer, two-column grid');

    await panel.getByRole('searchbox').fill('山水场景');
    await panel.waitForFunction(() => document.querySelector('#resultCount').textContent === '9 条');
    await panel.getByRole('searchbox').fill('不存在的关键词');
    await panel.getByText('没有找到相关内容').waitFor();
    await panel.getByRole('button', { name: '清除筛选' }).click();
    await panel.getByRole('combobox', { name: '内容类型', exact: true }).selectOption('生图词');
    await panel.getByRole('combobox', { name: '细分分类' }).selectOption('环境');
    const filtered = await panel.locator('.card').count(); assert(filtered > 0);
    await panel.getByRole('combobox', { name: '内容类型', exact: true }).selectOption('all');
    console.log('PASS: search, empty state, type and subcategory filters');

    const first = panel.locator('.card').first();
    await first.locator('.quick-copy').click();
    const copied = await electron.evaluate(() => global.galleryTestClipboard);
    assert(copied.startsWith('生成同一角色'));
    await first.locator('.bookmark').click();
    await panel.waitForFunction(() => document.querySelector('.card .bookmark').getAttribute('aria-pressed') === 'false');
    await first.locator('.bookmark').click();
    await panel.waitForFunction(() => document.querySelector('.card .bookmark').getAttribute('aria-pressed') === 'true');
    console.log('PASS: copy and bookmark toggle without altering OS clipboard');

    const existingPreview = electron.windows().find((page) => page.url().endsWith('/preview.html'));
    const previewPromise = existingPreview ? Promise.resolve(existingPreview) : electron.waitForEvent('window', { predicate: (page) => page !== panel });
    await first.locator('.media').hover();
    const preview = await previewPromise;
    await preview.waitForFunction(() => document.querySelector('#previewTitle').textContent.length > 0);
    wins = await bounds();
    const vb = wins.find((w) => w.url.endsWith('/preview.html')).bounds;
    assert(vb.x + vb.width <= pb.x); assert.equal(vb.width, 344);
    await setCursor(vb.x + vb.width - 20, vb.y + 100);
    await panel.evaluate(() => window.api.requestExpand(false));
    await panel.evaluate(() => window.api.autoCollapse());
    await wait(800);
    assert((await panel.evaluate(() => window.api.getPanelState())).expanded);
    await preview.screenshot({ path: path.join(output, 'gallery-preview.png') });
    await preview.getByRole('button', { name: '复制提示词', exact: true }).click();
    await preview.getByText('已复制', { exact: true }).waitFor();
    await setCursor(pb.x - 3, vb.y + 100); await wait(700);
    assert((await panel.evaluate(() => window.api.getPanelState())).expanded);
    console.log('PASS: left preview, crossing gap, copy from preview, no premature collapse');

    await setCursor(-10000, -10000);
    await panel.waitForFunction(async () => !(await window.api.getPanelState()).expanded);
    for (let i = 0; i < 30; i++) {
      wins = await bounds();
      if (wins.find((w) => w.url.endsWith('/panel.html')).bounds.width === 36) break;
      await wait(100);
    }
    assert.equal(wins.find((w) => w.url.endsWith('/panel.html')).bounds.width, 36);
    assert.equal(wins.find((w) => w.url.endsWith('/preview.html')).visible, false);
    console.log('PASS: leaving both windows closes preview and shrinks native window to handle');

    await panel.evaluate(() => window.api.requestExpand(true)); await wait(300);
    pb = (await bounds()).find((w) => w.url.endsWith('/panel.html')).bounds;
    // Direct API preview checks should not race a separate real hover timer.
    await panel.locator('#search').hover();
    await setCursor(pb.x + 100, pb.y + 120);
    await panel.evaluate(() => window.api.showPreview({ id: 'demo6', top: 180 }));
    await preview.waitForFunction(() => document.querySelector('#previewTitle').textContent === '室内场景');
    assert(await preview.locator('#previewMedia').isHidden());
    await preview.screenshot({ path: path.join(output, 'gallery-text-preview.png') });
    const hasVideo = await panel.evaluate(async () => !!(await window.api.getData()).view.prompts.find((p) => p.id === 'demo2').video);
    if (hasVideo) {
      await panel.evaluate(() => window.api.showPreview({ id: 'demo2', top: 200, play: true }));
      await preview.waitForFunction(() => document.querySelector('#previewVideo').readyState >= 2, null, { timeout: 8000 }).catch(async (error) => {
        console.error('Video preview state:', await preview.evaluate(() => ({ title: document.querySelector('#previewTitle').textContent, source: document.querySelector('#previewVideo').getAttribute('src'), error: document.querySelector('#previewVideo').error?.message, readyState: document.querySelector('#previewVideo').readyState })));
        throw error;
      });
      assert(await preview.locator('#previewVideo').isVisible());
      await panel.evaluate(() => window.api.showPreview({ id: 'demo1', top: 200 }));
      await preview.waitForFunction(() => document.querySelector('#previewVideo').paused && !document.querySelector('#previewVideo').getAttribute('src'));
      console.log('PASS: video playback and stopping playback when switching cards');
    }
    await panel.evaluate(() => window.api.hidePreview());
    await panel.evaluate(() => window.api.setConfig({ appearance: { theme: 'dark' }, panel: { width: 320 } }));
    await panel.waitForFunction(() => document.body.dataset.theme === 'dark' && window.innerWidth === 320);
    assert(await panel.evaluate(() => document.querySelector('.gallery').scrollWidth <= document.querySelector('.gallery').clientWidth));
    await panel.screenshot({ path: path.join(output, 'gallery-dark-320.png') });
    await panel.evaluate(() => window.api.setConfig({ appearance: { theme: 'light' }, panel: { width: 560 } }));
    await panel.waitForFunction(() => window.innerWidth === 560);
    assert(await panel.evaluate(() => document.querySelector('.list').scrollWidth <= document.querySelector('.list').clientWidth));
    console.log('PASS: text-only preview, dark mode, 320/560px width changes');

    await panel.getByRole('combobox', { name: '内容类型', exact: true }).selectOption('skills');
    assert(await panel.getByText('暂未发现 Skill', { exact: true }).isVisible());
    await panel.getByRole('combobox', { name: '内容类型', exact: true }).selectOption('all');
    await panel.locator('#list').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await panel.waitForFunction(() => document.querySelectorAll('.card').length > 30);
    console.log('PASS: Skill entry replaces snippets; prompt incremental scrolling');

    await panel.evaluate(() => window.api.setConfig({ panel: { edge: 'top', width: 384 } })).catch((err) => {
      // Changing docking edge intentionally destroys and recreates this window.
      if (!/closed|destroyed/.test(err.message)) throw err;
    });
    let topPanel;
    for (let i = 0; i < 40; i++) {
      topPanel = electron.windows().find((p) => !p.isClosed() && p.url().endsWith('/panel.html'));
      if (topPanel && topPanel !== panel) break;
      await wait(100);
    }
    assert(topPanel && topPanel !== panel);
    await topPanel.waitForFunction(() => document.querySelectorAll('.card').length > 0);
    await wait(300);
    pb = (await bounds()).find((w) => w.url.endsWith('/panel.html')).bounds;
    assert.equal(pb.width, 76); assert.equal(pb.height, 36);
    await topPanel.evaluate(() => window.api.requestExpand(true)); await wait(300);
    pb = (await bounds()).find((w) => w.url.endsWith('/panel.html')).bounds;
    await setCursor(pb.x + 100, pb.y + 120);
    await topPanel.evaluate(() => window.api.showPreview({ id: 'demo1', top: 200 })); await wait(300);
    assert((await bounds()).some((w) => w.url.endsWith('/preview.html') && w.visible));
    console.log('PASS: top-edge compatibility and preview after window recreation');
    assert.deepEqual(errors, []);
    console.log('ALL GALLERY CHECKS PASSED');
  } finally { await electron.close(); }
})().catch((err) => { console.error(err); process.exitCode = 1; });
