import { expect } from '@playwright/test';
import { test, startProvider, openExtension, dispose } from './fixtures';
import { snapshotVisibility, SNAPSHOT_COMPUTED_STYLES } from '../src/chrome/snapshot-visibility';
import { TEXT_PAINT_EVIDENCE_SOURCE, projectTextPaint } from '../src/chrome/snapshot-text-paint';

test('first-line projections require a proven flow and do not guess for ambiguous layouts', async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/target`);
    const cdp = await opened.context.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('Page.enable');
    const frame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
    const context = (await cdp.send('Page.createIsolatedWorld', { frameId: frame, worldName: 'firstline-proof' })).executionContextId;
    const probe = async (html: string) => {
      await page.setContent(`<style>p::first-line{color:black}</style>${html}`);
      const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [...SNAPSHOT_COMPUTED_STYLES], includeDOMRects: true });
      const candidates: any[] = [];
      snapshotVisibility(snapshot, { textPaintCandidates: candidates });
      const results = [];
      for (const candidate of candidates) {
        const object = await cdp.send('DOM.resolveNode', { backendNodeId: candidate.backendNodeId, executionContextId: context });
        const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.object.objectId!, functionDeclaration: TEXT_PAINT_EVIDENCE_SOURCE, returnByValue: true });
        const evidence = result.result.value?.[0];
        results.push({ source: candidate.sourceText, projection: projectTextPaint(candidate, evidence) });
      }
      return results;
    };
    const chinese = await probe('<p style="color:transparent;white-space:pre-line">第一行中文\n隐藏的第二行</p>');
    expect(chinese).toEqual([expect.objectContaining({ projection: { hidden: false, text: '第一行中文' } })]);
    for (const html of [
      '<p style="color:transparent">BASE <span style="color:transparent">SECRET</span> END<br>HIDDEN</p>',
      '<style>span {color:transparent}</style><p style="color:transparent">BASE <span>SECRET</span> END<br>HIDDEN</p>',
      '<style>a:visited {color:transparent}</style><p style="color:transparent">BASE<br>HIDDEN</p>',
      '<style>p::first-line {text-transform:uppercase}</style><p style="color:transparent">base<br>hidden</p>',
      '<style>p::first-line {-webkit-text-security:disc}</style><p style="color:transparent">base<br>hidden</p>',
      '<p style="color:transparent">BASE <span>SECRET</span> END<br>HIDDEN</p><script>document.querySelector("span").animate({color:["transparent","transparent"]},{duration:100000,fill:"both"})</script>',
      '<p style="color:transparent;width:30px">This text wraps before a break<br>HIDDEN</p>',
      '<div style="float:left;width:10px;height:60px"></div><p style="color:transparent">BASE<br>HIDDEN</p>',
      '<style>p::before {content:"X"}</style><p style="color:transparent">BASE<br>HIDDEN</p>',
      '<style>li {color:transparent;list-style-position:inside;width:90px} li::first-line {color:black} li::marker {content:"MARKERMMMMM "}</style><ul><li>HIDDENSECRET</li></ul>',
    ]) {
      const result = await probe(html);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every(({ projection }) => projection === undefined), html).toBe(true);
    }
    await page.route('http://localhost:*/firstline.css', (route) => route.fulfill({ contentType: 'text/css', body: 'span {color:transparent}' }));
    const external = await probe(`<link rel="stylesheet" href="${provider.origin.replace('127.0.0.1', 'localhost')}/firstline.css"><p style="color:transparent">BASE <span>SECRET</span> END<br>HIDDEN</p>`);
    expect(external.length).toBeGreaterThan(0);
    expect(external.every(({ projection }) => projection === undefined)).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

for (const mode of ['first-line', 'selection'] as const) for (const effect of ['shadow', 'stroke'] as const) test(`does not expose text from a transparent ${mode} ${effect}`, async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/target`);
      const paint = effect === 'shadow' ? 'text-shadow:1px 1px 0 transparent' : '-webkit-text-stroke:1px transparent';
      const css = mode === 'first-line'
        ? `#fixture::first-line{${paint}}`
        : `#fixture::selection{color:transparent;background:transparent;${paint}}`;
      const body = mode === 'first-line' ? '<span id="secret">HIDDENSECRET</span><br>HIDDENNEXT' : 'HIDDENSECRET';
      await page.setContent(`<style>#fixture{color:transparent;width:600px;line-height:30px}${css}</style><p id="fixture">${body}</p>`);
      const select = () => page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#fixture')!); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
      if (mode === 'selection') await select();
      const before = await page.locator('#fixture').screenshot();
      if (mode === 'selection') await page.evaluate(() => getSelection()!.removeAllRanges());
      else await page.locator('#secret').evaluate((el: HTMLElement) => { el.style.visibility = 'hidden'; });
      const after = await page.locator('#fixture').screenshot();
      expect(before.equals(after), `${mode} text must not paint pixels`).toBe(true);
      if (mode === 'selection') await select();
      else await page.locator('#secret').evaluate((el: HTMLElement) => { el.style.removeProperty('visibility'); });

      const cdp = await opened.context.newCDPSession(page);
      try {
        await cdp.send('DOM.enable'); await cdp.send('Page.enable');
        const frame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
        const context = (await cdp.send('Page.createIsolatedWorld', { frameId: frame, worldName: 'firstline-transparent-proof' })).executionContextId;
        const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [...SNAPSHOT_COMPUTED_STYLES], includeDOMRects: true });
        const candidates: any[] = [];
        snapshotVisibility(snapshot, { textPaintCandidates: candidates });
        const candidate = candidates.find((entry) => entry.sourceText === 'HIDDENSECRET');
        expect(candidate, mode).toBeTruthy();
        const object = await cdp.send('DOM.resolveNode', { backendNodeId: candidate.backendNodeId, executionContextId: context });
        const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.object.objectId!, functionDeclaration: TEXT_PAINT_EVIDENCE_SOURCE, returnByValue: true });
        expect(projectTextPaint(candidate, result.result.value?.[0]), mode).toEqual({ hidden: true });
      } finally { await cdp.detach(); }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
