'use strict';
const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');

(async () => {
  const env = { ...process.env, GALLERY_TEST_SYNC: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.PREVIEW_SETTINGS;
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(__dirname, 'gallery-test-app.cjs')], env });
  const errors = [];
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));
  try {
    const panel = await app.firstWindow(); panel.setDefaultTimeout(5000);
    await panel.waitForFunction(() => document.querySelectorAll('.card').length > 0);
    await panel.evaluate(() => window.api.requestExpand(true));
    await panel.waitForFunction(() => getComputedStyle(document.querySelector('#panel')).opacity === '1');
    await app.evaluate(({ BrowserWindow }) => {
      const b = BrowserWindow.getAllWindows()[0].getBounds(); global.galleryTestCursor = { x: b.x + 100, y: b.y + 200 };
    });
    await panel.waitForTimeout(150);
    const opened = app.waitForEvent('window');
    await panel.locator('.card .media').first().hover();
    const preview = await opened;
    const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().endsWith('/preview.html') && w.isVisible()));
    await preview.waitForFunction(() => document.querySelector('#previewTitle').textContent.length > 0);
    assert(await visible());
    for (let revision = 1; revision <= 3; revision++) {
      await panel.locator('#btnSync').click();
      await panel.waitForFunction(() => document.querySelector('#btnSync').classList.contains('spin'));
      await panel.waitForFunction(() => !document.querySelector('#btnSync').classList.contains('spin'));
      await panel.locator('.card .media').nth(revision).hover();
      await preview.waitForFunction(rev => document.querySelector('#previewText').textContent.includes('同步版本 ' + rev), revision);
      assert(await visible(), 'Hover preview must remain visible after sync');
    }
    console.log('PASS: three real sync button clicks followed by image hover show fresh preview text.');
    // Replacing cards while their hover timer is pending must retain the hover.
    await panel.evaluate(() => window.api.hidePreview());
    await panel.locator('#btnSync').click();
    await panel.waitForTimeout(200);
    await panel.locator('.card .media').first().hover();
    await panel.waitForFunction(() => !document.querySelector('#btnSync').classList.contains('spin'));
    await preview.waitForFunction(() => document.querySelector('#previewText').textContent.includes('同步版本 4'));
    assert(await visible());
    console.log('PASS: sync completing during a pending image hover still opens the preview.');
    // Windows can hide a native preview without clearing its cached item.
    // A subsequent sync must not leave that item permanently deduplicated.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/preview.html')).hide());
    await panel.locator('#btnSync').click();
    await panel.waitForFunction(() => !document.querySelector('#btnSync').classList.contains('spin'));
    await panel.locator('.card .media').first().hover();
    await preview.waitForTimeout(500);
    assert(await visible(), 'A cached preview hidden by Windows must reopen on hover after sync');
    console.log('PASS: a cached preview hidden by Windows reopens after sync.');
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
