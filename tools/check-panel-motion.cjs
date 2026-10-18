'use strict';
const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.PREVIEW_SETTINGS;
  const electron = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(__dirname, 'gallery-test-app.cjs')], env, timeout: 30000 });
  const page = await electron.firstWindow();
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const nativeBounds = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/panel.html')).getBounds());
  const cursor = (point) => electron.evaluate((_, p) => { global.galleryTestCursor = p; }, point);
  const collapsed = async () => {
    for (let i = 0; i < 40; i++) { if ((await nativeBounds()).width === 36) return; await wait(15); }
    throw new Error('Native window did not shrink');
  };
  try {
    await page.waitForFunction(() => document.querySelectorAll('.card').length > 0 && document.body.style.getPropertyValue('--panel-height'));
    await collapsed();
    assert.equal(await page.evaluate(async () => (await window.api.getConfig()).panel.autoCollapseMs), 40);
    await page.evaluate(() => {
      window.motion = { open: [], close: [], frames: [], sequence: null };
      window.api.on('panel:expand', () => {
        if (window.motion.openAt) window.motion.open.push(performance.now() - window.motion.openAt);
        window.motion.openAt = null;
        const until = performance.now() + 190;
        function frame() {
          const s = getComputedStyle(document.querySelector('#panel'));
          window.motion.frames.push({ t: performance.now(), opacity: Number(s.opacity), transform: s.transform });
          if (performance.now() < until) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
      window.api.on('panel:collapse', (p) => {
        window.motion.sequence = p.sequence;
        if (window.motion.closeAt) window.motion.close.push(performance.now() - window.motion.closeAt);
        window.motion.closeAt = null;
      });
    });
    const open = async () => {
      const b = await nativeBounds(); await cursor({ x: b.x + b.width - 12, y: b.y + b.height / 2 });
      await page.evaluate(() => {
        document.dispatchEvent(new MouseEvent('mouseleave'));
        window.motion.openAt = performance.now();
        document.querySelector('#handle').dispatchEvent(new MouseEvent('mouseenter'));
      });
      await page.waitForFunction(() => document.body.classList.contains('expanded'));
    };
    const close = async () => {
      await cursor({ x: -10000, y: -10000 });
      await page.evaluate(() => { window.motion.closeAt = performance.now(); document.dispatchEvent(new MouseEvent('mouseleave')); });
      await page.waitForFunction(() => !document.body.classList.contains('expanded'));
    };
    for (let i = 0; i < 5; i++) {
      const before = await page.locator('.card').first().evaluate((el) => el.offsetWidth);
      await open(); await wait(200);
      const after = await page.locator('.card').first().evaluate((el) => el.offsetWidth);
      assert.equal(before, after, 'Native resize must not reflow gallery cards');
      await close(); await collapsed();
    }
    const measured = await page.evaluate(() => window.motion);
    assert(measured.open.every((ms) => ms < 100), 'Open response must be under 100ms');
    assert(measured.close.every((ms) => ms < 100), 'Close response must be under 100ms');
    assert(measured.frames.filter((f) => f.opacity > 0 && f.opacity < 1).length >= 3, 'Opening must render intermediate animation frames');
    console.log('PASS: immediate opening, <100ms close response, stable card layout, animated intermediate frames');

    await open(); await wait(180);
    await cursor({ x: -10000, y: -10000 });
    const reversal = await page.evaluate(() => new Promise((resolve) => {
      window.motion.closeAt = performance.now();
      document.dispatchEvent(new MouseEvent('mouseleave'));
      const poll = setInterval(() => {
        if (document.body.classList.contains('expanded')) return;
        clearInterval(poll);
        resolve({ sequence: window.motion.sequence, opacity: Number(getComputedStyle(document.querySelector('#panel')).opacity) });
      }, 4);
    }));
    assert(reversal.opacity > 0, 'Catch exit while still animating');
    const layout = await page.evaluate(async () => (await window.api.getPanelState()).layout);
    await cursor({ x: layout.x + 100, y: layout.y + 120 });
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseenter')));
    await page.waitForFunction(() => document.body.classList.contains('expanded'));
    await page.evaluate((sequence) => window.api.collapseComplete(sequence), reversal.sequence);
    await wait(220);
    assert.equal((await nativeBounds()).width, 384);
    assert((await page.evaluate(() => window.api.getPanelState())).expanded);
    console.log('PASS: exit reverses immediately; stale completion cannot shrink reopened panel');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await close(); await collapsed(); await open();
    assert.equal(await page.locator('#panel').evaluate((el) => el.getAnimations().length), 0);
    await page.evaluate(() => window.api.requestCollapse()); await collapsed();
    await page.evaluate(() => document.querySelector('#handle').dispatchEvent(new MouseEvent('mouseenter')));
    await wait(90);
    assert.equal((await nativeBounds()).width, 36, 'Explicit close must not instantly reopen');
    console.log('PASS: reduced-motion closes without fallback delay; explicit close has no rebound');
    assert.deepEqual(errors, []);
    const report = { openResponseMs: measured.open, closeResponseMs: measured.close, intermediateFrames: measured.frames.filter((f) => f.opacity > 0 && f.opacity < 1).length, layoutStable: true, interruptible: true, reducedMotion: true };
    fs.writeFileSync(path.join(root, 'output/playwright/motion-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await electron.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
