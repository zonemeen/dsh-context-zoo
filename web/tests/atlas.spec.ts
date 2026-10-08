import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
});

test("language switching keeps strategy and progress, and survives reload", async ({ page }) => {
  await page.locator(".strategy-button").filter({ hasText: "Pi" }).click();
  await page.getByRole("button", { name: "步骤 4: 分别摘要两段" }).click();
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Pi", exact: true })).toBeVisible();
  await expect(page.locator(".context-flow")).toHaveAttribute("data-step", "3");
  await expect(page.locator(".pipeline-step").nth(3)).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Every context decision, visible." })).toBeVisible();
  await page.getByRole("button", { name: "切换到中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

test("all nine strategies render their own stages and formulas", async ({ page }) => {
  for (const name of ["DeepSeek Harness", "Claude Code", "Codex", "OpenCode", "Pi", "Qwen Code", "ZCode", "Kimi Code", "Cline"]) {
    await page.locator(".strategy-button").filter({ hasText: name }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.locator(".pipeline-step")).toHaveCount(5);
    await page.locator(".pipeline-step").last().click();
    await expect(page.locator(".context-flow")).toHaveAttribute("data-step", "4");
    await expect(page.locator(".checkpoint-block")).toHaveClass(/visible/);
  }
});

test("budget, scenarios, playback, and navigation are interactive", async ({ page }) => {
  await expect(page.getByLabel("模型窗口")).toHaveValue("1048576");
  await expect(page.locator("#window option")).toHaveText(["256K tokens", "512K tokens", "1M tokens"]);
  await expect(page.locator(".budget-value strong")).toHaveText("838,860");
  await expect(page.locator(".budget-footnote")).toContainText("W = 1,048,576 tokens");
  await page.getByLabel("模型窗口").selectOption("524288");
  await expect(page.locator(".budget-value strong")).toHaveText("419,430");
  await page.getByLabel("模型窗口").selectOption("262144");
  await expect(page.locator(".budget-value strong")).toHaveText("188,416");
  const original = await page.locator(".flow-stats strong").first().textContent();
  await page.getByLabel("对话场景").selectOption("tools");
  await expect(page.locator(".flow-stats strong").first()).not.toHaveText(original!);
  await page.getByRole("button", { name: "播放演示", exact: true }).click();
  await expect(page.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.locator(".context-flow")).toHaveAttribute("data-step", "1");
  await page.getByRole("button", { name: "机制对照", exact: true }).click();
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(9);
  await page.getByRole("button", { name: "案例与实测", exact: true }).click();
  await expect(page.getByRole("heading", { name: "从机制，走进具体任务。" })).toBeVisible();
});

test("the viewport fits both locales, and reduced motion starts paused", async ({ page }) => {
  await expect(page.getByRole("button", { name: "播放演示", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Switch to English" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Cases & evidence", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
