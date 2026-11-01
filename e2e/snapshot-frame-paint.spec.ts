import { expect } from '@playwright/test';
import { SNAPSHOT_FRAME_PAINT_SOURCE } from '../src/chrome/snapshot-frame-paint';
import { test, dispose, openExtension } from './fixtures';

test('proves a whole child frame only when parent paint is bounded and unobscured', async () => {
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto('about:blank');
    await page.setContent(`<!doctype html><style>body{margin:0}#frame{display:block;position:absolute;left:100px;top:100px;width:300px;height:150px;border:0}#caption{position:absolute;left:0;top:0;width:80px;height:24px;overflow:hidden;white-space:nowrap}</style><div id="caption">A clipped parent heading</div><iframe id="frame" srcdoc="<p>child</p>"></iframe>`);
    const read = async (noShadowRoots = true) => page.locator('#frame').evaluate((el, args) => (new Function(`return (${args.source})`)() as (this: Element, noShadowRoots: boolean) => unknown).call(el, args.noShadowRoots), { source: SNAPSHOT_FRAME_PAINT_SOURCE, noShadowRoots });
    const proof = await read();
    expect(proof).toMatchObject({ target: { x: 100, y: 100, width: 300, height: 150 } });
    expect(await read()).toEqual(proof);

    await page.locator('#caption').evaluate(el => { (el as HTMLElement).style.overflow = 'visible'; });
    expect(await read()).toBeNull();
    await page.locator('#caption').evaluate(el => { (el as HTMLElement).style.cssText += ';overflow:clip;overflow-clip-margin:50px'; });
    expect(await read()).toBeNull();
    await page.locator('#caption').evaluate(el => { (el as HTMLElement).style.cssText += ';overflow:hidden;overflow-clip-margin:0px'; });
    await page.evaluate(() => { document.body.style.contain = 'paint'; });
    expect(await read()).toBeNull();
    await page.evaluate(() => { document.body.style.contain = ''; });
    await page.evaluate(() => { const overlay=document.createElement('div'); overlay.id='overlay'; overlay.style.cssText='position:absolute;left:150px;top:110px;width:30px;height:30px;pointer-events:none;background:red'; document.body.append(overlay); });
    expect(await read()).toBeNull();
    await page.locator('#overlay').evaluate(el => el.remove());
    expect(await read()).toEqual(proof);

    await page.evaluate(() => { const host=document.createElement('div'); host.id='closed'; host.attachShadow({mode:'closed'}).innerHTML='<span>hidden subtree</span>'; document.body.append(host); });
    expect(await page.locator('#closed').evaluate(el => el.shadowRoot)).toBeNull();
    expect(await read(false)).toBeNull();
    await page.locator('#closed').evaluate(el => el.remove());

    await page.locator('#frame').evaluate(el => { (el as HTMLElement).style.transform = 'scale(.9)'; });
    expect(await read()).toBeNull();
    await page.locator('#frame').evaluate(el => { (el as HTMLElement).style.transform = ''; });
    await page.evaluate(() => { const popover=document.createElement('div'); popover.setAttribute('popover','manual'); document.body.append(popover); popover.showPopover(); });
    expect(await read()).toBeNull();
  } finally { await dispose(opened.context, opened.userDataDirectory); }
});
