export interface Client {
  ip: string;
  requests: number;
  first_seen: string;
  last_seen: string;
  version: number;
}

export interface ClientList { items: Client[]; total: number }
export interface Status {
  synchronized: boolean;
  stratum: number;
  selected_upstream: string | null;
  offset_ms: number | null;
  delay_ms: number | null;
  sync_age_seconds: number | null;
  uptime_seconds: number;
  listening: boolean;
  port: number;
  tracking_healthy: boolean;
  tracking_queue: number;
  totals: { clients: number; requests: number; last_request: number | null };
  metrics: { replies: number; rejected: number; rate_limited: number; tracking_dropped: number };
  upstreams: { host: string; address?: string; status: string; stratum?: number;
    offset_ms?: number; delay_ms?: number }[];
  configuration: { upstreams: string[]; sync_interval: number; sync_max_age: number;
    allowed_networks: string; rate_limit: number; listen_address: string };
}

export class APIError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

let token = '';
export function setToken(value: string): void { token = value; }

async function transport(path: string): Promise<Response> {
  let result: Response;
  try {
    result = await fetch(`/api/${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15000), cache: 'no-store',
    });
  } catch {
    throw new APIError('Server unavailable. Check your connection.', 0);
  }
  if (!result.ok) {
    const body = await result.json().catch(() => ({})) as { error?: string };
    throw new APIError(body.error || `Request failed (${result.status})`, result.status);
  }
  return result;
}

async function json<T>(path: string): Promise<T> { return (await transport(path)).json() as Promise<T>; }

export const api = {
  session: () => json<{ authentication_required: boolean }>('session'),
  status: () => json<Status>('status'),
  clients: (search = '', offset = 0, all = false) => {
    const params = new URLSearchParams({ search });
    if (!all) { params.set('limit', '25'); params.set('offset', String(offset)); }
    return json<ClientList>(`clients?${params}`);
  },
  backup: async () => (await transport('backup')).blob(),
};