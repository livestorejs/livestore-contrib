import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

test.skip(process.env.BASE_URL === undefined, "The real-network E2E runs only against the deployed Worker + frontend");

test("two isolated clients converge over the network, persist through reload, and expose live devtools", async ({
  browser,
  baseURL,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errors: string[] = [];
  const assets: Array<{ status: number; url: string }> = [];
  observePage(pageA, "A", errors, assets);
  observePage(pageB, "B", errors, assets);

  const documentId = `e2e_${Date.now()}`;
  await Promise.all([
    pageA.goto(`${baseURL}/?doc=${documentId}&client=playwright_a`),
    pageB.goto(`${baseURL}/?doc=${documentId}&client=playwright_b`),
  ]);
  await Promise.all([waitForClient(pageA), waitForClient(pageB)]);

  expect(await pageA.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  expect(await pageB.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  await expect(pageA.locator("body")).toHaveAttribute("data-storage-mode", "persisted");
  await expect(pageB.locator("body")).toHaveAttribute("data-storage-mode", "persisted");

  const editorA = pageA.getByTestId("editor").locator(".ProseMirror");
  const editorB = pageB.getByTestId("editor").locator(".ProseMirror");
  const initialRowsA = Number(await pageA.locator("#event-count").textContent());
  const initialOpsA = Number(await pageA.getByTestId("loro-op-count").textContent());
  await mkdir("test-results/evidence", { recursive: true });
  await pageA.screenshot({ path: "test-results/evidence/deployed-real-network-before.png", fullPage: true });

  await Promise.all([
    typeMarkedText(pageA, editorA, "Bold from client A", "Bold"),
    typeMarkedText(pageB, editorB, "Italic from client B", "Italic"),
  ]);

  await expect.poll(async () => editorA.innerHTML(), { timeout: 30_000 }).toBe(await editorB.innerHTML());
  await expect(editorA).toContainText("Bold from client A");
  await expect(editorA).toContainText("Italic from client B");
  await expect(editorB).toContainText("Bold from client A");
  await expect(editorB).toContainText("Italic from client B");
  await expect(editorA.locator("strong")).toContainText("Bold from client A");
  await expect(editorB.locator("strong")).toContainText("Bold from client A");
  await expect(editorA.locator("em")).toContainText("Italic from client B");
  await expect(editorB.locator("em")).toContainText("Italic from client B");

  await expect
    .poll(async () => Number(await pageA.locator("#event-count").textContent()))
    .toBeGreaterThan(initialRowsA);
  await expect
    .poll(async () => Number(await pageA.getByTestId("loro-op-count").textContent()))
    .toBeGreaterThan(initialOpsA);
  await expect(pageA.getByTestId("loro-json")).toContainText("Bold from client A");
  await expect(pageA.getByTestId("prosemirror-json")).toContainText("Italic from client B");
  await expect(pageA.getByTestId("sync-flow").locator('[data-direction="pushed"]')).not.toHaveCount(0);
  await expect(pageA.getByTestId("sync-flow").locator('[data-direction="pulled"]')).not.toHaveCount(0);
  await expect(pageB.getByTestId("sync-flow").locator('[data-direction="pushed"]')).not.toHaveCount(0);
  await expect(pageB.getByTestId("sync-flow").locator('[data-direction="pulled"]')).not.toHaveCount(0);

  const expandableEvent = pageA.getByTestId("event-log").locator("details").filter({ hasNotText: "bootstrap" }).first();
  await expandableEvent.locator("summary").click();
  await expect(expandableEvent.locator('[data-role="event-full-bytes"]')).toBeVisible();
  await expect(expandableEvent.locator('[data-role="event-full-bytes"] pre').first()).not.toBeEmpty();

  const persistedHtml = await editorB.innerHTML();
  await pageB.reload();
  await waitForClient(pageB);
  await expect(pageB.getByTestId("editor").locator(".ProseMirror")).toHaveJSProperty("innerHTML", persistedHtml);
  await expect(pageB.getByTestId("editor").locator(".ProseMirror")).toContainText("Bold from client A");
  await expect(pageB.locator("body")).toHaveAttribute("data-storage-mode", "persisted");
  await expect(pageB.locator("body")).toHaveAttribute("data-network-connected", "true");

  await pageA.screenshot({ path: "test-results/evidence/deployed-real-network-devtools.png", fullPage: true });
  expect(assets.some(({ status, url }) => status === 200 && url.endsWith(".wasm"))).toBe(true);
  expect(assets.some(({ status, url }) => status === 200 && /worker/i.test(url))).toBe(true);
  expect(errors).toEqual([]);

  await Promise.all([contextA.close(), contextB.close()]);
});

async function waitForClient(page: Page): Promise<void> {
  await expect.poll(() => page.locator("body").getAttribute("data-ready")).toBe("true");
  await expect
    .poll(() => page.locator("body").getAttribute("data-network-connected"), { timeout: 30_000 })
    .toBe("true");
  await expect.poll(() => page.locator("body").getAttribute("data-synced"), { timeout: 30_000 }).toBe("true");
  await expect(page.getByTestId("editor").locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
}

async function typeMarkedText(
  page: Page,
  editor: ReturnType<Page["locator"]>,
  text: string,
  markButton: "Bold" | "Italic",
): Promise<void> {
  await editor.click();
  await page.getByRole("button", { name: markButton, exact: true }).click();
  await page.keyboard.type(text);
}

function observePage(
  page: Page,
  label: string,
  errors: string[],
  assets: Array<{ status: number; url: string }>,
): void {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label} console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${label} page: ${error.message}`));
  page.on("response", (response) => {
    if (/\.wasm($|\?)|worker/i.test(response.url())) assets.push({ status: response.status(), url: response.url() });
  });
}
