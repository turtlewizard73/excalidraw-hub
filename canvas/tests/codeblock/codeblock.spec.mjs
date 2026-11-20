// Code blocks end to end: paste -> rendered image element with customData, hover toggle, edit, sync to server.
// Run: see playwright.codeblock.config.mjs. Screenshots go to test-results/codeblock-shots/ for a visual check.
import { test, expect } from '@playwright/test';

const SHOTS = 'test-results/codeblock-shots';
const MERMAID = 'flowchart LR\n  Paste --> Render --> Toggle';
const PLANTUML = '@startuml\nAlice -> Bob: hello\nBob --> Alice: hi\n@enduml';
const SALT = '@startsalt\n{\n  Login    | "user   "\n  Password | "****   "\n  [Cancel] | [  OK   ]\n}\n@endsalt';

async function serverElements(request) {
  const res = await request.get('/api/elements');
  return (await res.json()).elements ?? [];
}

async function waitForBlocks(request, n, pred = () => true) {
  let blocks = [];
  await expect.poll(async () => {
    blocks = (await serverElements(request)).filter((e) => e.customData?.kind === 'codeblock' && pred(e));
    return blocks.length;
  }, { timeout: 20000 }).toBe(n);
  return blocks;
}

async function paste(page, text, at) {
  await page.mouse.move(at.x, at.y);
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test.beforeEach(async ({ page, request }) => {
  page.on('console', (m) => { if (process.env.CB_DEBUG || m.type() === 'error' || m.text().includes('Code block')) console.log('[browser]', m.text()) });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await request.delete('/api/elements/clear');
  await page.goto('/');
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  // Upstream race: the WebSocket's initial scene is applied only after the font preload and
  // replaces anything drawn before it. Wait for fonts, then a beat, before editing.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.mouse.click(1100, 800); // a user interaction, so auto-sync runs
});

test('pasting mermaid creates a rendered code block that syncs to the server', async ({ page, request }) => {
  await paste(page, MERMAID, { x: 500, y: 400 });
  const [block] = await waitForBlocks(request, 1);
  expect(block.type).toBe('image');
  expect(block.customData).toMatchObject({ kind: 'codeblock', lang: 'mermaid', source: MERMAID, view: 'diagram' });
  const files = (await (await request.get('/api/files')).json()).files;
  expect(files[block.fileId]?.mimeType).toBe('image/png');
  await page.screenshot({ path: `${SHOTS}/mermaid-diagram.png` });
});

test('hover toggles between code and diagram, and edit re-renders', async ({ page, request }) => {
  await paste(page, MERMAID, { x: 500, y: 400 });
  const [block] = await waitForBlocks(request, 1);

  await page.mouse.move(510, 405); // over the block (a real move, so hover is recomputed)
  await page.getByTestId('codeblock-toggle').click();
  const [code] = await waitForBlocks(request, 1, (e) => e.customData.view === 'code');
  expect(code.fileId).not.toBe(block.fileId);
  expect(code.x).toBe(block.x);
  await page.mouse.move(500, 380);
  await page.screenshot({ path: `${SHOTS}/mermaid-code.png` });

  await page.mouse.move(500, 380);
  await page.getByTestId('codeblock-toggle').click();
  const [back] = await waitForBlocks(request, 1, (e) => e.customData.view === 'diagram');
  expect(back.fileId).toBe(block.fileId); // same render, same file

  await page.mouse.move(500, 380);
  await page.getByTestId('codeblock-edit').click();
  await page.getByTestId('codeblock-source').fill('flowchart TD\n  Edited --> Works');
  await page.getByTestId('codeblock-save').click();
  const [edited] = await waitForBlocks(request, 1, (e) => e.customData.source.includes('Edited'));
  expect(edited.fileId).not.toBe(block.fileId);
});

test('plantuml and salt render through the local plantuml-server', async ({ page, request }) => {
  await paste(page, PLANTUML, { x: 350, y: 300 });
  await waitForBlocks(request, 1);
  await paste(page, SALT, { x: 800, y: 500 });
  const blocks = await waitForBlocks(request, 2);
  expect(blocks.map((b) => b.customData.lang).sort()).toEqual(['plantuml', 'salt']);
  await page.screenshot({ path: `${SHOTS}/plantuml-salt.png` });
});

test('plain text still pastes as text', async ({ page, request }) => {
  await paste(page, 'pie chart ideas', { x: 500, y: 400 });
  await expect.poll(async () => (await serverElements(request)).filter((e) => e.type === 'text').length, { timeout: 20000 }).toBe(1);
  expect((await serverElements(request)).some((e) => e.customData?.kind === 'codeblock')).toBe(false);
});

test('new code block button opens the editor and creates a salt block', async ({ page, request }) => {
  await page.getByRole('button', { name: /Code block/ }).click();
  await page.getByTestId('codeblock-lang').selectOption('salt');
  await page.getByTestId('codeblock-source').fill('{\n  [Button] | ^Droplist^\n}');
  await page.getByTestId('codeblock-save').click();
  const [block] = await waitForBlocks(request, 1);
  expect(block.customData.lang).toBe('salt');
});

test('a selected block keeps its own buttons, above the block, while another block is hovered', async ({ page, request }) => {
  await paste(page, MERMAID, { x: 350, y: 300 });
  await waitForBlocks(request, 1);
  await paste(page, SALT, { x: 850, y: 550 }); // a new block is selected
  const blocks = await waitForBlocks(request, 2);
  const salt = blocks.find((b) => b.customData.lang === 'salt');
  const mermaid = blocks.find((b) => b.customData.lang === 'mermaid');
  const bar = page.getByTestId('codeblock-hover');

  await page.mouse.move(355, 305); // hover the other block
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveAttribute('data-block-id', salt.id);
  const box = await bar.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(550 - salt.height / 2); // fully above the salt block (zoom 1)
  await page.screenshot({ path: `${SHOTS}/selected-buttons.png` });

  await page.getByTestId('codeblock-toggle').click(); // the selected block shows code: same rule
  await waitForBlocks(request, 1, (e) => e.id === salt.id && e.customData.view === 'code');
  await page.mouse.move(355, 305);
  await expect(bar).toHaveAttribute('data-block-id', salt.id);
  await expect(page.getByTestId('codeblock-toggle')).toHaveText(/Diagram/);

  await page.mouse.click(1100, 800); // deselect: hover decides again
  await page.mouse.move(355, 305);
  await expect(bar).toHaveAttribute('data-block-id', mermaid.id);
  await page.mouse.move(1100, 800);
  await expect(bar).toHaveCount(0);
});

test('at the top edge the bar flips under the block and stays reachable on hover', async ({ page, request }) => {
  await paste(page, MERMAID, { x: 500, y: 400 });
  const [block] = await waitForBlocks(request, 1);
  await page.mouse.click(1100, 800); // deselect: hover decides
  const bar = page.getByTestId('codeblock-hover');
  await page.mouse.move(500, 400);
  const above = await bar.boundingBox(); // not flipped yet: the block's top is just under the bar
  const top = above.y + above.height + 8;
  const canvasTop = (await page.locator('.excalidraw').first().boundingBox()).y;
  await page.mouse.move(500, 600);
  await page.mouse.wheel(0, top - (canvasTop + 20)); // block's top edge to 20 px under the canvas top
  await page.waitForTimeout(300);
  const bottom = canvasTop + 20 + block.height;
  await page.mouse.move(500, bottom - 5); // over the block
  await expect(bar).toHaveCount(1);
  const box = await bar.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(bottom - 2); // under the block
  await page.mouse.move(500, bottom + 6); // in the gap between block and bar: still hovered
  await expect(bar).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/flipped-buttons.png` });
});
