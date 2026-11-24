import { expect, test, type Locator, type Page } from "@playwright/test";

const bookId = "local-writing";
const first = "# 雨夜\n\n她点了点头。\n\n她点了点头。\n\n她走进雨里。\n";
const second = "# 清晨\n\n天亮了。\n";
const generated = "她捏紧纸条，总算下了决心。";
const booksUrl = `/api/v1/books/${bookId}`;
const notes = (page: Page) => page.getByRole("textbox", { name: "调整要求（可选）" });
const draft = (page: Page) => page.locator('textarea[aria-label="书稿页"]');

async function select(editor: Locator, start: number, end = start) {
  await editor.focus();
  await editor.evaluate((node: HTMLTextAreaElement, range) => node.setSelectionRange(...range), [start, end] as const);
}

async function mockBook(page: Page) {
  const chapters = [
    { number: 1, title: "雨夜", wordCount: 20, observations: [], provenance: "generated" },
    { number: 2, title: "清晨", wordCount: 4, observations: [], provenance: "generated" },
  ];
  const saved = ["", first, second];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/project") return route.fulfill({ json: { language: "zh", languageExplicit: true } });
    if (url.pathname === booksUrl) {
      return route.fulfill({ json: {
        book: { id: bookId, title: "测试书稿", genre: "玄幻", status: "active", chapterWordCount: 500, language: "zh" },
        chapters, nextChapter: 3,
      } });
    }
    const match = url.pathname.match(new RegExp(`^${booksUrl}/chapters/([12])(/workspace)?$`));
    if (match) {
      const chapterNumber = Number(match[1]);
      if (match[2]) return route.fulfill({ json: { chapterNumber, brief: "", plan: null, versions: [], canDelete: false } });
      if (route.request().method() === "PUT") saved[chapterNumber] = route.request().postDataJSON().content;
      return route.fulfill({ json: { ok: true, chapterNumber, content: saved[chapterNumber], latestChapter: 2 } });
    }
    return route.fulfill({ status: 404, json: { error: "Not a fixture endpoint" } });
  });
  return saved;
}

async function openFullEditor(page: Page, title = "雨夜") {
  await page.goto(`/#/book/${bookId}/settings`);
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
}

test("previews a transition from the unsaved draft, then saves only on demand", async ({ page }) => {
  const saved = await mockBook(page);
  let request: unknown;
  await page.route(`**${booksUrl}/chapters/1/workspace/local-write`, async (route) => {
    request = route.request().postDataJSON();
    await route.fulfill({ json: { text: generated } });
  });
  await openFullEditor(page);
  const unsaved = first.replace("她走进雨里。", "她推门走进雨里。");
  const editor = draft(page);
  await editor.fill(unsaved);
  const cursor = unsaved.indexOf("她推门");
  await select(editor, cursor);
  await page.getByRole("button", { name: "局部编写" }).click();
  const dialog = page.getByRole("dialog", { name: "在光标处补写过渡" });
  await dialog.getByRole("button", { name: "生成预览" }).click();
  await expect(dialog.getByText(generated)).toBeVisible();
  expect(request).toEqual({ before: unsaved.slice(0, cursor), selection: "", after: unsaved.slice(cursor) });
  await expect(editor).toHaveValue(unsaved);
  expect(saved[1]).toBe(first);

  await dialog.getByRole("button", { name: "采纳" }).click();
  const updated = unsaved.slice(0, cursor) + generated + "\n\n" + unsaved.slice(cursor);
  await expect(editor).toHaveValue(updated);
  expect(saved[1]).toBe(first);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(saved[1]).toBe(updated);
});

test("rewrites only the selected occurrence in the sidebar and supports retry and cancel", async ({ page }) => {
  const saved = await mockBook(page);
  let count = 0;
  await page.route(`**${booksUrl}/chapters/1/workspace/local-write`, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ selection: "她点了点头。", instruction: "写出她下定决心。" });
    if (++count === 1) return route.fulfill({ status: 500, json: { error: "model unavailable" } });
    return route.fulfill({ json: { text: generated } });
  });
  await page.goto(`/#/book/${bookId}`);
  await page.getByText("01 雨夜", { exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = draft(page);
  const start = first.lastIndexOf("她点了点头。");
  await select(editor, start, start + "她点了点头。".length);
  await page.getByRole("button", { name: "局部编写" }).click();
  const dialog = page.getByRole("dialog", { name: "改写选区" });
  await notes(page).fill("写出她下定决心。");
  await dialog.getByRole("button", { name: "生成预览" }).click();
  await expect(dialog.getByRole("alert")).toContainText("model unavailable");
  await expect(notes(page)).toHaveValue("写出她下定决心。");
  await expect(editor).toHaveValue(first);
  await dialog.getByRole("button", { name: "生成预览" }).click();
  await expect(dialog.getByText(generated)).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(editor).toHaveValue(first);

  await select(editor, start, start + "她点了点头。".length);
  await page.getByRole("button", { name: "局部编写" }).click();
  await notes(page).fill("写出她下定决心。");
  await dialog.getByRole("button", { name: "生成预览" }).click();
  await dialog.getByRole("button", { name: "采纳" }).click();
  await expect(editor).toHaveValue(first.slice(0, start) + generated + first.slice(start + "她点了点头。".length));
  expect(saved[1]).toBe(first);
});

test("does not carry a pending suggestion into another chapter", async ({ page }) => {
  const saved = await mockBook(page);
  const gate = Promise.withResolvers<void>();
  await page.route(`**${booksUrl}/chapters/1/workspace/local-write`, async (route) => {
    await gate.promise;
    await route.fulfill({ json: { text: generated } }).catch(() => {});
  });
  try {
    await openFullEditor(page);
    await select(draft(page), first.indexOf("她走进雨里。"));
    await page.getByRole("button", { name: "局部编写" }).click();
    const request = page.waitForRequest(`**${booksUrl}/chapters/1/workspace/local-write`);
    await page.getByRole("button", { name: "生成预览" }).click();
    await request;
    await page.evaluate((id) => { window.location.hash = `#/book/${id}`; }, bookId);
    await page.getByText("02 清晨", { exact: true }).click();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    gate.resolve();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(draft(page)).toHaveValue(second);
    expect(saved[1]).toBe(first);
  } finally {
    gate.resolve();
  }
});

test("saves and removes the local-writing route in project settings", async ({ page }) => {
  await mockBook(page);
  let overrides: Record<string, string> = { reviser: "whole-chapter-model" };
  await page.route("**/api/v1/project/model-overrides", async (route) => {
    if (route.request().method() === "PUT") {
      overrides = route.request().postDataJSON().overrides;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { overrides } });
  });
  await page.goto("/#/settings");
  const routing = page.locator("section").filter({ has: page.getByRole("heading", { name: "Agent 模型路由" }) });
  const routes = routing.getByRole("combobox", { name: "选择 Agent" });
  await expect(routes).toHaveCount(1);
  await routing.getByRole("button", { name: "添加路由" }).click();
  const localRoute = routes.last();
  await localRoute.selectOption({ label: "chapter-local-write（局部编写）" });
  await localRoute.locator("..").getByPlaceholder("模型 ID").fill("local-editor-model");
  const save = routing.getByRole("button", { name: "保存", exact: true }).last();
  await save.click();
  await expect.poll(() => overrides).toEqual({ reviser: "whole-chapter-model", "chapter-local-write": "local-editor-model" });

  await page.reload();
  await expect(localRoute).toHaveValue("chapter-local-write");
  await expect(localRoute.locator("..").getByPlaceholder("模型 ID")).toHaveValue("local-editor-model");
  await localRoute.locator("..").getByRole("button", { name: "remove" }).click();
  await save.click();
  await expect.poll(() => overrides).toEqual({ reviser: "whole-chapter-model" });
});
