import { test, expect } from '@playwright/test';
import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';

test('console loads directly, tracks real clients, downloads, and recovers', async ({ page }, testInfo) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(20, 23, 24)');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lock console' })).toHaveCount(0);
  await expect(page.locator('#sync-label')).toHaveText('Not synchronized');

  await new Promise<void>((resolve, reject) => {
    const socket = createSocket('udp4');
    const timer = setTimeout(() => { socket.close(); reject(new Error('NTP timeout')); }, 3000);
    socket.on('error', error => { clearTimeout(timer); socket.close(); reject(error); });
    socket.on('message', message => {
      clearTimeout(timer); socket.close();
      if (message.length === 48 && (message[0]! >> 6) === 3) resolve();
      else reject(new Error('Expected unsynchronized NTP response'));
    });
    const packet = Buffer.alloc(48); packet[0] = 0x23;
    packet.writeUInt32BE(Math.floor(Date.now() / 1000) + 2208988800, 40);
    socket.send(packet, 10124, '127.0.0.1');
  });
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    return page.locator('#clients').textContent();
  }).toContain('127.0.0.1');
  await expect(page.locator('#clients tr').first()).toContainText('v4');
  await page.getByRole('searchbox').fill('no-match');
  await expect(page.locator('#clients')).toContainText('No matching clients');
  await page.getByRole('searchbox').fill('127.0.0.1');
  await expect(page.locator('#clients')).toContainText('127.0.0.1');

  const exportEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export clients as JSON' }).click();
  const exported = await exportEvent;
  const payload = JSON.parse(await readFile((await exported.path())!, 'utf8'));
  expect(payload.items[0].ip).toBe('127.0.0.1');
  const backupEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Back up SQLite' }).click();
  const backup = await backupEvent;
  const bytes = await readFile((await backup.path())!);
  expect(bytes.subarray(0, 15).toString()).toBe('SQLite format 3');

  await page.route('**/api/status', route => route.abort());
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#error')).toContainText('Server unavailable');
  await page.unroute('**/api/status');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#error')).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const pixels = await page.locator('#traffic').evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d')!;
    return [...context.getImageData(0, 0, element.width, element.height).data].some(value => value > 0);
  });
  expect(pixels).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
  expect(failures).toEqual([]);
});