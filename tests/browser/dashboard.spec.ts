import { test, expect } from '@playwright/test';
import { createSocket } from 'node:dgram';

test('simple console tracks real clients and recovers', async ({ page }, testInfo) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(20, 23, 24)');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lock console' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back up SQLite' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export clients as JSON' })).toHaveCount(0);
  await expect(page.getByText('Runtime configuration', { exact: true })).toHaveCount(0);
  await expect(page.locator('#sync-label')).toHaveText('Not synchronized');
  await expect(page.getByRole('heading', { name: 'Overview' })).toHaveCount(0);
  expect(await page.locator('.upstreams').evaluate(element =>
    Boolean(element.compareDocumentPosition(document.querySelector('.clients-section')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

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
  await expect(page.locator('#clients tr').first().locator('td')).toHaveCount(4);
  await expect(page.getByRole('columnheader', { name: 'First seen' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Last seen' })).toBeVisible();
  await page.getByRole('searchbox').fill('no-match');
  await expect(page.locator('#clients')).toContainText('No matching clients');
  await page.getByRole('searchbox').fill('127.0.0.1');
  await expect(page.locator('#clients')).toContainText('127.0.0.1');

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

test('synchronized status shows the last sync age', async ({ page }, testInfo) => {
  let syncAge: number | null = 120;
  let listening = true;
  let trackingHealthy = true;
  await page.route('**/api/status', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), synchronized: true,
      listening, tracking_healthy: trackingHealthy, sync_age_seconds: syncAge,
      selected_upstream: 'time.example.com' } });
  });
  await page.goto('/');
  await expect(page.locator('#sync-label')).toHaveText('Synchronized 2 minutes ago');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('synchronized.png'), fullPage: true });
  for (const [age, label] of [
    [0, '0 seconds ago'], [1, '1 second ago'], [59, '59 seconds ago'],
    [60, '1 minute ago'], [3600, '1 hour ago'], [86400, '1 day ago'], [null, ''],
  ] as const) {
    syncAge = age;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('#sync-label')).toHaveText(`Synchronized${label ? ` ${label}` : ''}`);
  }
  listening = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#sync-label')).toHaveText('Listener offline');
  listening = true;
  trackingHealthy = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#sync-label')).toHaveText('Tracking degraded');
});