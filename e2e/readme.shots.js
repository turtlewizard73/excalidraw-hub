// README screenshots (run by scripts/screenshots.sh, never by e2e.sh). Builds made-up demo drawings through the
// canvas REST API and the hub's agent save, then drives the real page. Output: test-results/readme/*.png.
import { test, expect } from '@playwright/test';

const CANVAS = process.env.CANVAS_URL;
const HUB = process.env.HUB_URL;
const OUT = 'test-results/readme';
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const box = (id, x, y, text, bg, w = 190, h = 80) => ({ id, type: 'rectangle', x, y, width: w, height: h, backgroundColor: bg, fillStyle: 'solid', roundness: { type: 3 }, label: { text } });
const arrow = (id, from, to, [x1, y1], [x2, y2], text) => ({ id, type: 'arrow', x: x1, y: y1, points: [[0, 0], [x2 - x1, y2 - y1]], start: { id: from }, end: { id: to }, endArrowhead: 'arrow', ...(text ? { label: { text } } : {}) });
const note = (id, x, y, text, size = 20) => ({ id, type: 'text', x, y, text, fontSize: size });

// Made-up projects only. Each entry is drawn on an empty canvas and saved through the hub like an agent would.
const DRAWINGS = [
  { project: 'garden', label: 'beds', versioned: true, elements: [
    note('t', 0, -70, 'Spring beds', 28),
    box('a', 0, 0, 'Tomatoes', '#ffc9c9'), box('b', 230, 0, 'Herbs', '#b2f2bb'), box('c', 460, 0, 'Beans', '#ffec99'),
  ] },
  { project: 'garden', label: 'drip', versioned: true, elements: [
    note('t', 0, -70, 'Spring beds + drip line', 28),
    box('a', 0, 0, 'Tomatoes', '#ffc9c9'), box('b', 230, 0, 'Herbs', '#b2f2bb'), box('c', 460, 0, 'Beans', '#ffec99'),
    box('tap', 230, 200, 'Rain barrel', '#a5d8ff'),
    arrow('p1', 'tap', 'a', [280, 200], [95, 80]), arrow('p2', 'tap', 'b', [325, 200], [325, 80]), arrow('p3', 'tap', 'c', [370, 200], [555, 80]),
  ] },
  { project: 'recipes', label: 'ideas', versioned: false, elements: [
    note('t', 0, 0, 'ideas: meal plans, shopping list, timers', 24),
  ] },
  { project: 'recipes', label: 'arch', versioned: true, elements: [
    note('t', 0, -80, 'Recipe app: architecture', 28),
    box('mob', 0, 0, 'Mobile app', '#d0bfff'), box('web', 0, 160, 'Web app', '#d0bfff'),
    box('api', 330, 80, 'Recipe API', '#a5d8ff'),
    box('db', 660, 0, 'Recipes DB', '#b2f2bb'), box('img', 660, 160, 'Photo storage', '#ffec99'),
    arrow('a1', 'mob', 'api', [190, 40], [330, 110], 'REST'), arrow('a2', 'web', 'api', [190, 200], [330, 130], 'REST'),
    arrow('a3', 'api', 'db', [520, 110], [660, 40]), arrow('a4', 'api', 'img', [520, 130], [660, 200]),
  ] },
  { project: 'onboarding', label: 'week1', versioned: true, elements: [
    box('d1', 0, 0, 'Day 1: laptop + accounts', '#e9ecef', 260), box('d2', 320, 0, 'Day 2: codebase tour', '#e9ecef', 260),
    box('d5', 640, 0, 'Day 5: first PR', '#b2f2bb', 260),
    arrow('x1', 'd1', 'd2', [260, 40], [320, 40]), arrow('x2', 'd2', 'd5', [580, 40], [640, 40]),
  ] },
];

const MERMAID = 'flowchart LR\n  Idea --> Sketch --> Review\n  Review -->|approved| Build\n  Review -->|changes| Sketch';
const PLANTUML = '@startuml\nactor Cook\nCook -> "Recipe API": search "pasta"\n"Recipe API" --> Cook: 12 recipes\n@enduml';
const SALT = '@startsalt\n{\n  Recipe   | "Pancakes      "\n  Servings | ^4^\n  [x] Vegetarian\n  [Cancel] | [  Save  ]\n}\n@endsalt';

test.describe.configure({ mode: 'serial' });
let page, frame, iframeBox;

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const drawing = (file) => page.locator(`[data-testid="drawing"][data-file="${file}"]`);
const fit = () => post(`${CANVAS}/api/viewport`, { scrollToContent: true });
const settle = (ms = 1500) => page.waitForTimeout(ms);
const codeBlocks = async () => (await (await fetch(`${CANVAS}/api/elements`)).json()).elements.filter((e) => e.customData?.kind === 'codeblock');

async function paste(text, x, y) {
  await page.mouse.move(iframeBox.x + x, iframeBox.y + y);
  await frame.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test('seed demo drawings (no tab open, agent saves)', async () => {
  for (const d of DRAWINGS) {
    await fetch(`${CANVAS}/api/elements/clear`, { method: 'DELETE' });
    expect((await post(`${CANVAS}/api/elements/batch`, { elements: d.elements })).ok).toBe(true);
    const res = await post(`${HUB}/api/save`, { project: d.project, label: d.label, versioned: d.versioned });
    expect(res.status, await res.clone().text()).toBe(200);
  }
});

test('overview: sidebar, a loaded drawing, hover actions', async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/');
  frame = page.frameLocator('#canvas');
  await expect(frame.getByText('Connected', { exact: true })).toBeVisible({ timeout: 20000 });
  frame = page.frames().find((f) => f.url().startsWith(CANVAS));
  await frame.evaluate(() => document.fonts.ready);
  await settle();
  iframeBox = await page.locator('#canvas').boundingBox();
  for (const p of ['garden', 'recipes', 'onboarding']) {
    await page.locator(`details[data-project="${p}"]`).evaluate((d) => { d.open = true; });
  }
  await drawing('recipes_v0_arch.excalidraw').locator('button.open').click();
  await expect(page.getByTestId('current')).toHaveText('recipes / recipes_v0_arch.excalidraw');
  await settle();
  await fit();
  await settle();
  await drawing('garden_v1_drip.excalidraw').hover();
  await shot('hub-overview');
});

test('unsaved badge after an edit', async () => {
  iframeBox = await page.locator('#canvas').boundingBox(); // the status line above it may have moved it
  await frame.locator('[data-testid="toolbar-ellipse"]').click({ force: true });
  const { x, y } = iframeBox;
  await page.mouse.move(x + 640, y + 620);
  await page.mouse.down();
  await page.mouse.move(x + 860, y + 720, { steps: 8 });
  await page.mouse.up();
  await frame.locator('[data-testid="toolbar-selection"]').click({ force: true });
  await page.mouse.click(x + 700, y + 240); // deselect on empty canvas: hides the properties panel
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes', { timeout: 8000 });
  await page.mouse.move(x + 1000, y + 100);
  await shot('hub-unsaved');
});

test('code blocks: Mermaid, PlantUML, Salt', async () => {
  // Save the edit as a new version (shows the message), then start an empty canvas for the code blocks.
  await page.getByTestId('save-version').click();
  await expect(page.getByTestId('dirty')).toHaveText('Saved', { timeout: 8000 });
  await fetch(`${CANVAS}/api/elements/clear`, { method: 'DELETE' });
  await settle();
  iframeBox = await page.locator('#canvas').boundingBox();
  await page.mouse.click(iframeBox.x + iframeBox.width - 60, iframeBox.y + iframeBox.height - 120); // focus the canvas so it takes pastes
  await paste(MERMAID, 150, 260);
  await expect.poll(async () => (await codeBlocks()).length, { timeout: 20000 }).toBe(1);
  await paste(PLANTUML, 150, 560);
  await expect.poll(async () => (await codeBlocks()).length, { timeout: 20000 }).toBe(2);
  await paste(SALT, 760, 560);
  await expect.poll(async () => (await codeBlocks()).length, { timeout: 20000 }).toBe(3);
  await page.keyboard.press('Shift+Digit1'); // zoom to fit all
  await settle();
  await page.mouse.click(iframeBox.x + iframeBox.width - 100, iframeBox.y + 200); // deselect on empty canvas
  // Save it through the form, so the shot shows a saved drawing.
  await page.getByTestId('save-label').fill('flows');
  await page.getByTestId('save-version').click();
  await expect(page.getByTestId('dirty')).toHaveText('Saved', { timeout: 8000 });
  await page.mouse.move(iframeBox.x + iframeBox.width - 40, iframeBox.y + iframeBox.height - 40);
  await shot('code-blocks');
});

test('code block: hover shows Code/Diagram toggle and Edit', async () => {
  const mermaid = (await codeBlocks()).find((b) => b.customData.lang === 'mermaid');
  // Fit the block to half the viewport, centred, then hover the middle of the canvas.
  await post(`${CANVAS}/api/viewport`, { scrollToElementIds: [mermaid.id], viewportZoomFactor: 0.5 });
  await settle();
  const at = { x: iframeBox.width / 2, y: iframeBox.height / 2 };
  await page.mouse.move(iframeBox.x + at.x, iframeBox.y + at.y);
  await frame.getByTestId('codeblock-toggle').click();
  await expect.poll(async () => (await codeBlocks()).find((b) => b.customData.lang === 'mermaid').customData.view, { timeout: 20000 }).toBe('code');
  await page.mouse.click(iframeBox.x + iframeBox.width - 100, iframeBox.y + 200); // deselect
  await post(`${CANVAS}/api/viewport`, { scrollToElementIds: [mermaid.id], viewportZoomFactor: 0.5 }); // the block changed size: centre it again
  await settle();
  await page.mouse.move(iframeBox.x + at.x + 5, iframeBox.y + at.y + 5);
  await expect(frame.getByTestId('codeblock-toggle')).toBeVisible();
  await page.screenshot({ path: `${OUT}/code-block-toggle.png`, clip: { x: iframeBox.x + at.x - 360, y: iframeBox.y + at.y - 210, width: 720, height: 420 } });
});
