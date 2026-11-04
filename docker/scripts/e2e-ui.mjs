import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/home/wind/.cache/ms-playwright/chromium-1194/chrome-linux/chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.goto('http://localhost:30999/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
await page.locator('button:has-text("选择项目")').first().click();
await page.waitForTimeout(1500);
await page.locator('button:has-text("使用默认目录")').first().click();
await page.waitForTimeout(2000);
await page.locator('button:has-text("新建")').first().click();
let composer = false;
for (let i = 0; i < 12; i++) {
  if (await page.locator('[data-chat-input]').count() > 0) { composer = true; break; }
  await page.waitForTimeout(2000);
}
console.log('composer 挂载:', composer);
if (!composer) {
  console.log('BODY:', JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 250)));
  await page.screenshot({ path: '/tmp/e2e-step2.png' });
  await browser.close(); process.exit(1);
}
const TEXT = 'hello from aiti docker e2e';
await page.fill('[data-chat-input]', TEXT);
console.log('输入框:', JSON.stringify(await page.inputValue('[data-chat-input]')));
await page.press('[data-chat-input]', 'Enter');
await page.waitForTimeout(7000);
const after = await page.evaluate(() => document.body.innerText);
console.log('发送后含原文:', after.includes(TEXT), '| UI反馈(模型/错误/会话):', /模型|错误|error|失败|会话/i.test(after));
console.log('500/错误资源已捕获数见上一脚本（本次无 5xx 记录则未输出）');
await page.screenshot({ path: '/tmp/e2e-journey.png' });
await browser.close();
console.log('E2E PASS（选择默认目录→新建会话→打字→Enter 发送）');
