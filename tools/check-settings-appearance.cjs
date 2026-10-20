'use strict';
// Exercises settings through the real IPC and an isolated application profile.
const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const output = path.join(root, 'output', 'playwright');

(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.PREVIEW_SETTINGS;
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(__dirname, 'gallery-test-app.cjs')], env });
  const errors = [];
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));
  try {
    const panel = await app.firstWindow();
    await panel.waitForFunction(() => document.querySelectorAll('.card').length > 0);
    assert.equal(await panel.locator('#handle').evaluate(e => getComputedStyle(e).opacity), '0.8');
    const opened = app.waitForEvent('window');
    await panel.evaluate(() => window.api.openSettings());
    const settings = await opened;
    await settings.waitForFunction(() => document.querySelector('#handleOpacity').value === '80' && document.querySelector('#accent').value === '#ed7059');
    const settingsState = () => app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/settings.html'));
      return { visible: w.isVisible(), minimized: w.isMinimized() };
    });
    assert.equal((await settingsState()).visible, true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/settings.html')).hide());
    await panel.evaluate(() => window.api.openSettings());
    assert.equal((await settingsState()).visible, true, 'Reopening hidden settings must show them');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/settings.html')).minimize());
    await panel.evaluate(() => window.api.openSettings());
    assert.deepEqual(await settingsState(), { visible: true, minimized: false });
    await settings.locator('[data-tab="look"]').click();
    await settings.screenshot({ path: path.join(output, 'settings-appearance-light.png') });
    const slide = async value => {
      await settings.locator('#handleOpacity').fill(String(value));
      await panel.waitForFunction(value => getComputedStyle(document.querySelector('#handle')).opacity === String(value / 100), value);
      assert.equal(await settings.locator('.demo-tab').evaluate(e => getComputedStyle(e).opacity), String(value / 100));
      await settings.waitForFunction(() => document.querySelector('#lookSaveState').textContent === '已自动保存');
    };
    await slide(10); await slide(100); await slide(60);
    const configFile = path.join(output, 'gallery-profile/config.json');
    assert.equal(JSON.parse(fs.readFileSync(configFile)).appearance.handleOpacity, .6);
    await settings.reload();
    await settings.waitForFunction(() => document.querySelector('#handleOpacity').value === '60');
    await settings.locator('[data-tab="look"]').click();
    // Rapid edits across different fields must retain every change.
    await settings.evaluate(() => {
      const set = (id, value, type) => { const e = document.getElementById(id); e.value = value; e.dispatchEvent(new Event(type, { bubbles: true })); };
      set('handleOpacity', '35', 'input'); set('theme', 'dark', 'change'); set('previewLines', '3', 'change');
    });
    await settings.waitForFunction(() => document.querySelector('#lookSaveState').textContent === '已自动保存');
    const cfg = await panel.evaluate(() => window.api.getConfig());
    assert.equal(cfg.appearance.handleOpacity, .35); assert.equal(cfg.appearance.theme, 'dark'); assert.equal(cfg.appearance.previewLines, 3);
    await settings.screenshot({ path: path.join(output, 'settings-appearance-dark.png') });
    await panel.evaluate(() => window.api.requestExpand(true));
    await panel.waitForFunction(() => getComputedStyle(document.querySelector('#panel')).opacity === '1');
    assert.equal(await panel.locator('body').evaluate(e => getComputedStyle(e).opacity), '1');
    assert.equal(await settings.locator('body').evaluate(e => getComputedStyle(e).opacity), '1');
    const previewOpened = app.waitForEvent('window');
    await panel.locator('.card .media').first().hover();
    const preview = await previewOpened;
    await preview.waitForSelector('.preview');
    assert.equal(await preview.locator('.preview').evaluate(e => getComputedStyle(e).opacity), '1');
    const nativeOpacity = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.getOpacity()));
    assert(nativeOpacity.every(v => v === 1), 'Native windows must stay fully opaque');
    await settings.locator('#theme').selectOption('light');
    await settings.locator('#handleOpacity').fill('80');
    await settings.waitForFunction(() => document.querySelector('#lookSaveState').textContent === '已自动保存');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/settings.html')).setSize(760, 660));
    for (const tab of ['source', 'prompt', 'skills', 'look', 'guide']) {
      await settings.locator(`[data-tab="${tab}"]`).click();
      const noOverflow = await settings.locator('main').evaluate(e => e.scrollWidth <= e.clientWidth);
      assert(noOverflow, `No horizontal overflow in ${tab} at minimum width`);
    }
    await settings.locator('[data-tab="look"]').click();
    await settings.screenshot({ path: path.join(output, 'settings-appearance-compact.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: default 80%, live 10–100%, persistence, rapid edits, light/dark and minimum-width tabs; drawer, preview and settings remain opaque.');
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
