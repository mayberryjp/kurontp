import { createIcons, Activity, ArrowDownToLine, ArrowLeft, ArrowRight, Clock3,
  Database, LogOut, Network, RefreshCw, Search, Server, ShieldCheck, X } from 'lucide';
import { api, APIError, setToken, type ClientList, type Status } from './api';
import './style.css';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="header"><div class="brand"><span class="brand-mark"><i data-lucide="network"></i></span>
    <span>Kuro<span class="brand-sub">NTP CONSOLE</span></span></div>
    <div class="header-right"><span class="local-time" id="clock"></span><span class="local-label">LOCAL TIME</span>
      <button id="logout" class="icon-button" title="Lock console" aria-label="Lock console" hidden><i data-lucide="log-out"></i></button></div></header>
  <main><div class="page-title"><div><div class="eyebrow">TIME INFRASTRUCTURE</div><h1>Server overview</h1></div>
    <div class="page-actions"><label class="auto-refresh"><input id="auto" type="checkbox" checked />Live</label>
      <button class="icon-button" id="refresh" title="Refresh" aria-label="Refresh"><i data-lucide="refresh-cw"></i></button>
      <button id="backup" class="button"><i data-lucide="database"></i>Back up SQLite</button></div></div>
    <div id="error" class="error-banner" role="alert" hidden></div>
    <section id="sync-strip" class="sync-strip pending" aria-live="polite"><span class="status-dot"></span>
      <strong id="sync-label">Connecting</strong><span id="sync-detail">Waiting for server status</span><span class="protocol">NTP v3 / v4</span></section>
    <section class="stats" aria-label="Server metrics">
      <article><span class="stat-label">TOTAL REQUESTS<i data-lucide="activity"></i></span><strong id="total-requests">--</strong><span class="stat-note">Persisted requests</span></article>
      <article><span class="stat-label">KNOWN CLIENTS<i data-lucide="network"></i></span><strong id="total-clients">--</strong><span class="stat-note">Unique source IPs</span></article>
      <article><span class="stat-label">CLOCK OFFSET<i data-lucide="clock-3"></i></span><strong id="offset">--<small>ms</small></strong><span id="offset-note" class="stat-note">Awaiting synchronization</span></article>
      <article><span class="stat-label">SERVER STRATUM<i data-lucide="server"></i></span><strong id="stratum">--</strong><span id="stratum-note" class="stat-note">Not synchronized</span></article>
    </section>
    <section class="network-section"><div class="upstreams"><div class="section-heading"><h2>Upstream sources</h2><span class="tag">ENV MANAGED</span></div>
      <div id="upstreams" class="upstream-list"><p class="empty">Loading upstreams...</p></div></div>
      <div class="traffic"><div class="section-heading"><h2>Request activity</h2><span id="rate" class="mono">-- req/s</span></div>
        <canvas id="traffic" aria-label="Recent request rate" role="img"></canvas><div class="chart-footer"><span id="chart-label">Waiting for samples</span><span>Now</span></div></div></section>
    <section class="clients-section"><div class="section-heading clients-heading"><div class="heading-inline"><h2>Clients</h2><span id="client-count" class="count">0</span></div>
      <div class="client-actions"><div class="search"><i data-lucide="search"></i><input id="search" type="search" placeholder="Search source IP" aria-label="Search source IP" /></div>
        <button id="export" class="icon-button" title="Export clients as JSON" aria-label="Export clients as JSON"><i data-lucide="arrow-down-to-line"></i></button></div></div>
      <div class="table-scroll"><table><thead><tr><th>Source IP</th><th>Requests</th><th>First seen</th><th>Last seen</th><th>Protocol</th></tr></thead>
        <tbody id="clients"><tr><td colspan="5" class="empty">Loading clients...</td></tr></tbody></table></div>
      <div class="table-footer"><span id="page-label">--</span><div class="pagination"><button id="previous" class="icon-button" aria-label="Previous page" title="Previous page" disabled><i data-lucide="arrow-left"></i></button>
        <button id="next" class="icon-button" aria-label="Next page" title="Next page" disabled><i data-lucide="arrow-right"></i></button></div></div>
    </section>
    <details class="configuration"><summary><i data-lucide="shield-check"></i>Runtime configuration</summary><dl id="configuration"></dl></details>
    <footer><span><span class="tiny-dot"></span> Kuro / SQLite</span><span id="last-updated">Not yet updated</span></footer>
  </main>
  <dialog id="login"><form id="login-form"><span class="dialog-mark"><i data-lucide="shield-check"></i></span><h2>Unlock console</h2>
    <label for="token">Admin token</label><input id="token" type="password" autocomplete="current-password" required />
    <p id="login-error" role="alert"></p><button class="button primary" type="submit">Connect</button></form></dialog>
  <div id="toast" role="status" hidden></div>`;

const icons = { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, Clock3, Database,
  LogOut, Network, RefreshCw, Search, Server, ShieldCheck, X };
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
const login = element<HTMLDialogElement>('login');
let authRequired = false;

function showLogin(): void {
  if (!login.open) login.showModal();
  element<HTMLInputElement>('token').focus();
}
login.addEventListener('cancel', event => event.preventDefault());

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
  const config = status.configuration;
  const entries: [string, string][] = [
    ['NTP listener', `${config.listen_address}:${status.port}`],
    ['Sync interval / expiry', `${config.sync_interval}s / ${config.sync_max_age}s`],
    ['Allowed networks', config.allowed_networks], ['Per-IP reply limit', `${config.rate_limit} / second`],
    ['Rejected / rate limited', `${status.metrics.rejected} / ${status.metrics.rate_limited}`],
    ['Tracking queue / dropped', `${status.tracking_queue} / ${status.metrics.tracking_dropped}`],
    ['Uptime', `${Math.floor(status.uptime_seconds / 60)} minutes`],
  ];
  element('configuration').innerHTML = entries.map(([key, value]) =>
    `<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join('');
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
    <td title="${escape(client.last_seen)}">${escape(date(client.last_seen))}</td><td><span class="version">v${client.version}</span></td></tr>`).join('')
    : `<tr><td colspan="5" class="empty">${element<HTMLInputElement>('search').value ? 'No matching clients' : 'No clients seen yet'}</td></tr>`;
  text('page-label', result.total ? `${offset + 1}-${offset + result.items.length} of ${number.format(result.total)} clients` : '0 clients');
  element<HTMLButtonElement>('previous').disabled = offset === 0;
  element<HTMLButtonElement>('next').disabled = offset + 25 >= result.total;
}

async function refresh(): Promise<void> {
  if (busy || login.open) return;
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
    if (error instanceof APIError && error.status === 401) showLogin();
    else { text('error', `${error instanceof Error ? error.message : 'Unable to load data'} Displayed values may be stale.`); element('error').hidden = false; }
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
element('login-form').addEventListener('submit', event => {
  event.preventDefault();
  const button = element<HTMLButtonElement>('login-form').querySelector('button')!;
  button.disabled = true;
  setToken(element<HTMLInputElement>('token').value);
  void api.status().then(() => {
    element<HTMLInputElement>('token').value = ''; text('login-error', '');
    login.close(); element('logout').hidden = false; void refresh();
  }).catch(error => { setToken(''); text('login-error', error.message); })
    .finally(() => { button.disabled = false; });
});
element('logout').addEventListener('click', () => {
  setToken(''); element('logout').hidden = true;
  element('clients').innerHTML = '<tr><td colspan="5" class="empty">Console locked</td></tr>';
  showLogin();
});

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function toast(message: string): void {
  text('toast', message); element('toast').hidden = false;
  setTimeout(() => { element('toast').hidden = true; }, 4000);
}
async function action(id: string, work: () => Promise<void>): Promise<void> {
  const button = element<HTMLButtonElement>(id); button.disabled = true;
  try { await work(); } catch (error) {
    if (error instanceof APIError && error.status === 401) showLogin();
    else toast(error instanceof Error ? error.message : 'Request failed');
  } finally { button.disabled = false; }
}
element('backup').addEventListener('click', () => void action('backup', async () => {
  download(await api.backup(), 'kuro-backup.sqlite3'); toast('SQLite backup downloaded');
}));
element('export').addEventListener('click', () => void action('export', async () => {
  const clients = await api.clients(element<HTMLInputElement>('search').value, 0, true);
  download(new Blob([JSON.stringify(clients, null, 2)], { type: 'application/json' }), 'kuro-clients.json');
}));

function clock(): void {
  text('clock', new Date().toLocaleTimeString(undefined, { hour12: false }));
}
clock(); setInterval(clock, 1000);
setInterval(() => { if (element<HTMLInputElement>('auto').checked && !document.hidden) void refresh(); }, 5000);
void api.session().then(session => {
  authRequired = session.authentication_required;
  if (authRequired) showLogin(); else void refresh();
}).catch(() => void refresh());