import { createIcons, Activity, ArrowLeft, ArrowRight, Clock3,
  Network, RefreshCw, Search, Server } from 'lucide';
import { api, type ClientList, type Status } from './api';
import './style.css';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="header"><div class="brand"><span class="brand-mark"><i data-lucide="network"></i></span>
    <span>Kuro<span class="brand-sub">NTP CONSOLE</span></span></div>
    <div class="header-right"><span class="local-time" id="clock"></span><span class="local-label">LOCAL TIME</span></div></header>
  <main><div class="page-title"><h1>Overview</h1>
    <button class="icon-button" id="refresh" title="Refresh" aria-label="Refresh"><i data-lucide="refresh-cw"></i></button></div>
    <div id="error" class="error-banner" role="alert" hidden></div>
    <section id="sync-strip" class="sync-strip pending" aria-live="polite"><span class="status-dot"></span>
      <div class="sync-copy"><strong id="sync-label">Connecting</strong><span id="sync-detail">Waiting for server status</span></div><span class="protocol" id="listener">UDP 123</span></section>
    <section class="stats" aria-label="Server metrics">
      <article><span class="stat-label">Clients<i data-lucide="network"></i></span><strong id="total-clients">--</strong><span class="stat-note">Unique source IPs</span></article>
      <article><span class="stat-label">Requests<i data-lucide="activity"></i></span><strong id="total-requests">--</strong><span class="stat-note">Total received</span></article>
      <article><span class="stat-label">Clock offset<i data-lucide="clock-3"></i></span><strong id="offset">--<small>ms</small></strong><span id="offset-note" class="stat-note">Awaiting synchronization</span></article>
      <article><span class="stat-label">Stratum<i data-lucide="server"></i></span><strong id="stratum">--</strong><span id="stratum-note" class="stat-note">Not synchronized</span></article>
    </section>
    <section class="clients-section"><div class="section-heading clients-heading"><div class="heading-inline"><h2>Clients</h2><span id="client-count" class="count">0</span></div>
      <div class="search"><i data-lucide="search"></i><input id="search" type="search" placeholder="Search source IP" aria-label="Search source IP" /></div></div>
      <div class="table-scroll"><table><thead><tr><th>Source IP</th><th>Requests</th><th>First seen</th><th>Last seen</th></tr></thead>
        <tbody id="clients"><tr><td colspan="4" class="empty">Loading clients...</td></tr></tbody></table></div>
      <div class="table-footer"><span id="page-label">--</span><div class="pagination"><button id="previous" class="icon-button" aria-label="Previous page" title="Previous page" disabled><i data-lucide="arrow-left"></i></button>
        <button id="next" class="icon-button" aria-label="Next page" title="Next page" disabled><i data-lucide="arrow-right"></i></button></div></div>
    </section>
    <section class="network-section"><div class="upstreams"><div class="section-heading"><h2>Time servers</h2></div>
      <div id="upstreams" class="upstream-list"><p class="empty">Loading time servers...</p></div></div>
      <div class="traffic"><div class="section-heading"><h2>Activity</h2><span id="rate" class="mono">-- req/s</span></div>
        <canvas id="traffic" aria-label="Recent request rate" role="img"></canvas><div class="chart-footer"><span id="chart-label">Waiting for samples</span><span>Now</span></div></div></section>
    <footer><span><span class="tiny-dot"></span> NTP v3 / v4</span><span id="last-updated">Not yet updated</span></footer>
  </main>`;

const icons = { Activity, ArrowLeft, ArrowRight, Clock3, Network, RefreshCw, Search, Server };
function iconize(): void { createIcons({ icons }); }
iconize();

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function text(id: string, value: string): void { element(id).textContent = value; }
function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;' })[char]!);
}
const number = new Intl.NumberFormat();
const date = (value: string) => new Date(value).toLocaleString(undefined, {
  month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const fixed = (value: number | null | undefined) => value == null ? '--' : value.toFixed(2);
let offset = 0;
let busy = false;
let searchTimer: ReturnType<typeof setTimeout>;
let prior: { requests: number; at: number } | undefined;
const history: number[] = [];

function drawChart(): void {
  const canvas = element<HTMLCanvasElement>('traffic');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext('2d')!;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  const theme = getComputedStyle(document.documentElement);
  context.strokeStyle = theme.getPropertyValue('--line').trim();
  context.lineWidth = 1;
  for (let row = 1; row < 4; row++) {
    context.beginPath(); context.moveTo(0, height * row / 4);
    context.lineTo(width, height * row / 4); context.stroke();
  }
  if (!history.length) return;
  const max = Math.max(1, ...history) * 1.15;
  context.beginPath();
  history.forEach((value, index) => {
    const position = index * width / Math.max(history.length - 1, 1);
    const level = height - 8 - value / max * (height - 16);
    if (index === 0) context.moveTo(position, level); else context.lineTo(position, level);
  });
  context.strokeStyle = theme.getPropertyValue('--green').trim(); context.lineWidth = 2; context.stroke();
  if (history.length > 1) {
    context.lineTo(width, height); context.lineTo(0, height); context.closePath();
    context.fillStyle = theme.getPropertyValue('--chart-fill').trim(); context.fill();
  }
}
new ResizeObserver(drawChart).observe(element('traffic'));

function renderStatus(status: Status): void {
  const healthy = status.synchronized && status.listening && status.tracking_healthy;
  element('sync-strip').className = `sync-strip ${healthy ? 'healthy' : 'pending'}`;
  text('sync-label', healthy ? 'Synchronized' : !status.listening ? 'Listener offline'
    : !status.tracking_healthy ? 'Tracking degraded' : 'Not synchronized');
  text('sync-detail', healthy ? `Following ${status.selected_upstream} / UDP ${status.port}`
    : status.synchronized ? 'Check server health' : 'Waiting for a valid upstream time sample');
  text('listener', `UDP ${status.port}`);
  text('total-requests', number.format(status.totals.requests));
  text('total-clients', number.format(status.totals.clients));
  element('offset').innerHTML = `${fixed(status.offset_ms)}<small>ms</small>`;
  text('offset-note', status.synchronized ? `Round trip ${fixed(status.delay_ms)} ms` : 'No current sync');
  text('stratum', String(status.stratum));
  text('stratum-note', status.synchronized ? `Synced ${Math.round(status.sync_age_seconds || 0)}s ago` : 'Unsynchronized');
  element('upstreams').innerHTML = status.upstreams.map(source => `
    <div class="upstream"><span class="source-icon"><i data-lucide="server"></i></span><div class="source-name"><strong>${escape(source.host)}</strong>
    <span>${escape(source.address || 'No time sample')}</span></div><span class="source-delay mono">${source.delay_ms == null ? '--' : `${fixed(source.delay_ms)} ms`}</span>
    <span class="source-status ${source.host === status.selected_upstream && status.synchronized ? 'selected' : ''}">${source.host === status.selected_upstream && status.synchronized ? 'Selected' : escape(source.status)}</span></div>`).join('');
  const now = performance.now();
  if (prior && now - prior.at >= 1000) {
    const rate = Math.max(0, (status.totals.requests - prior.requests) / ((now - prior.at) / 1000));
    history.push(rate);
    if (history.length > 60) history.shift();
    text('rate', `${rate.toFixed(1)} req/s`);
    text('chart-label', `${history.length} recent samples`);
    drawChart();
  }
  prior = { requests: status.totals.requests, at: now };
  iconize();
}

function renderClients(result: ClientList): void {
  text('client-count', number.format(result.total));
  element('clients').innerHTML = result.items.length ? result.items.map(client => `
    <tr><td><span class="ip-mark"></span><span class="mono ip">${escape(client.ip)}</span></td>
    <td class="mono requests">${number.format(client.requests)}</td>
    <td title="${escape(client.first_seen)}">${escape(date(client.first_seen))}</td>
    <td title="${escape(client.last_seen)}">${escape(date(client.last_seen))}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">${element<HTMLInputElement>('search').value ? 'No matching clients' : 'No clients seen yet'}</td></tr>`;
  text('page-label', result.total ? `${offset + 1}-${offset + result.items.length} of ${number.format(result.total)} clients` : '0 clients');
  element<HTMLButtonElement>('previous').disabled = offset === 0;
  element<HTMLButtonElement>('next').disabled = offset + 25 >= result.total;
}

async function refresh(): Promise<void> {
  if (busy) return;
  busy = true;
  element('refresh').classList.add('refreshing');
  const query = element<HTMLInputElement>('search').value;
  try {
    const [status, clients] = await Promise.all([api.status(), api.clients(query, offset)]);
    renderStatus(status);
    renderClients(clients);
    element('error').hidden = true;
    text('last-updated', `Updated ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    text('error', `${error instanceof Error ? error.message : 'Unable to load data'} Displayed values may be stale.`);
    element('error').hidden = false;
  } finally {
    busy = false;
    element('refresh').classList.remove('refreshing');
    if (query !== element<HTMLInputElement>('search').value) void refresh();
  }
}

element('refresh').addEventListener('click', () => void refresh());
element('search').addEventListener('input', () => {
  clearTimeout(searchTimer); offset = 0;
  searchTimer = setTimeout(() => void refresh(), 250);
});
element('previous').addEventListener('click', () => { offset = Math.max(0, offset - 25); void refresh(); });
element('next').addEventListener('click', () => { offset += 25; void refresh(); });

function clock(): void {
  text('clock', new Date().toLocaleTimeString(undefined, { hour12: false }));
}
clock(); setInterval(clock, 1000);
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
void refresh();