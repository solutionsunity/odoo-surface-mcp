/**
 * Odoo JSON-RPC client — session-based wrapper around /web/dataset/call_kw.
 *
 * Calling convention for execute():
 *   execute(model, method, args, kwargs)
 *   where args  = positional arguments to the ORM method (array)
 *         kwargs = keyword arguments to the ORM method (object)
 *
 * Example:
 *   execute("res.partner", "search_read", [domain], { fields: ["name"], limit: 10 })
 */

const SESSION_EXPIRED = ['session expired', 'session_invalid', 'not logged', 'odoo.http.sessionexpired'];

function isSessionExpired(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return SESSION_EXPIRED.some(p => msg.includes(p));
}

interface RpcResponse {
  result?: unknown;
  error?: { message?: string; data?: { message?: string } };
}

/** Target server version, normalised so SaaS series compare in line: 17.0 < saas~17.4 < 18.0. */
export interface OdooVersion {
  major: number;
  minor: number;
  saas: boolean;
  edition: 'ce' | 'ee';
}

/**
 * Parse `server_version_info` — odoo/release.py `version_info`, serialised as
 * [major, minor, micro, level, serial, edition]: major is an int on stable series
 * ([17, 0, 0, 'final', 0, '']) and 'saas~N' on SaaS ones (['saas~19', 3, 0, 'final', 0, 'e']).
 * The last element is 'e' on Enterprise, '' on Community.
 */
function parseVersion(info: unknown): OdooVersion {
  if (!Array.isArray(info) || info.length < 6) {
    throw new Error(`Unrecognised server_version_info: ${JSON.stringify(info)}`);
  }
  const [rawMajor, minor, , , , edition] = info as [number | string, number, unknown, unknown, unknown, string];
  const saas = typeof rawMajor === 'string';
  const major = saas ? Number(rawMajor.replace(/^saas~/, '')) : rawMajor;
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    throw new Error(`Unrecognised server_version_info: ${JSON.stringify(info)}`);
  }
  return { major, minor, saas, edition: edition === 'e' ? 'ee' : 'ce' };
}

/** Facts read at authentication; they live and die with the session. */
interface Session {
  uid: number;
  version: OdooVersion;
}

export class OdooClient {
  private _session: Session | null = null;
  private _idCounter = 1;
  private _cookies = new Map<string, string>();
  private _groupXmlids: Set<string> | null = null;

  constructor(
    private url: string,
    private readonly db: string,
    private readonly username: string,
    private readonly password: string,
  ) {
    this.url = url.replace(/\/$/, '');
  }

  static fromEnv(): OdooClient {
    const url      = process.env.ODOO_URL;
    const db       = process.env.ODOO_DB;
    const username = process.env.ODOO_USERNAME ?? process.env.ODOO_USER;
    const password = process.env.ODOO_PASSWORD;
    const missing  = ['ODOO_URL', 'ODOO_DB', 'ODOO_PASSWORD'].filter(k => !process.env[k]);
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    return new OdooClient(url!, db!, username ?? 'admin', password!);
  }

  // -------------------------------------------------------------------------
  // Cookie management
  // -------------------------------------------------------------------------

  private cookieHeader(): string {
    return [...this._cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private updateCookies(response: Response): void {
    // Node 18.14+ exposes getSetCookie(); fall back to single header string.
    const setCookies: string[] =
      typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean) as string[];

    for (const raw of setCookies) {
      const pair = raw.split(';')[0].trim();
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      this._cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  // -------------------------------------------------------------------------
  // Core RPC
  // -------------------------------------------------------------------------

  private async rpc(route: string, params: Record<string, unknown>): Promise<unknown> {
    const payload = { jsonrpc: '2.0', method: 'call', id: this._idCounter++, params };
    let url = `${this.url}${route}`;

    for (let hop = 0; hop < 5; hop++) {
      const cookie = this.cookieHeader();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cookie) headers['Cookie'] = cookie;

      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        redirect: 'manual',
      });
      this.updateCookies(resp);

      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location') ?? '';
        if (!loc) break;
        if ((loc.startsWith('http://') || loc.startsWith('https://')) && loc.includes(route)) {
          this.url = loc.slice(0, loc.lastIndexOf(route));
        }
        url = loc.startsWith('http') ? loc : `${this.url}${loc}`;
        continue;
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      const data = await resp.json() as RpcResponse;
      if (data.error) {
        const err = data.error;
        throw new Error(err.data?.message ?? err.message ?? JSON.stringify(err));
      }
      return data.result;
    }
    throw new Error(`Too many redirects for ${route}`);
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private async session(): Promise<Session> {
    if (this._session) return this._session;
    const result = await this.rpc('/web/session/authenticate', {
      db: this.db, login: this.username, password: this.password,
    }) as { uid?: number; server_version_info?: unknown } | null;
    const uid = result?.uid;
    if (!uid) throw new Error(`Odoo authentication failed: ${this.username}@${this.db}`);
    this._session = { uid, version: parseVersion(result.server_version_info) };
    return this._session;
  }

  async getUid(): Promise<number> {
    return (await this.session()).uid;
  }

  async version(): Promise<OdooVersion> {
    return (await this.session()).version;
  }

  // -------------------------------------------------------------------------
  // ORM execute
  // -------------------------------------------------------------------------

  async execute(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    await this.session();
    const kw = { model, method, args, kwargs };
    try {
      return await this.rpc('/web/dataset/call_kw', kw);
    } catch (exc) {
      if (isSessionExpired(exc)) {
        this._session = null;
        await this.session();
        return await this.rpc('/web/dataset/call_kw', kw);
      }
      throw exc;
    }
  }

  async httpCall(route: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.session();
    try {
      return await this.rpc(route, params);
    } catch (exc) {
      if (isSessionExpired(exc)) {
        this._session = null;
        await this.session();
        return await this.rpc(route, params);
      }
      throw exc;
    }
  }

  // -------------------------------------------------------------------------
  // Convenience helpers
  // -------------------------------------------------------------------------

  async ping(): Promise<Record<string, unknown>> {
    const t0 = Date.now();
    await this.rpc('/web/webclient/version_info', {});
    const rpcMs = Date.now() - t0;
    const t1 = Date.now();
    const { uid, version } = await this.session();
    const authMs = Date.now() - t1;
    return {
      status: 'ok',
      version,
      db: this.db,
      uid,
      rpc_latency_ms: rpcMs,
      auth_latency_ms: authMs,
    };
  }

  async getFormArch(model: string): Promise<string> {
    const result = await this.execute(model, 'get_views', [[[false, 'form']]]) as {
      views: { form: { arch: string } };
    };
    return result.views.form.arch;
  }

  async getFormFields(model: string): Promise<Record<string, unknown>> {
    try {
      const result = await this.execute(model, 'get_views', [[[false, 'form']]]) as {
        views: { form: { fields?: Record<string, unknown> } };
        models?: Record<string, unknown>;
      };
      const modelsMeta = result.models as Record<string, unknown> | undefined;
      if (modelsMeta?.[model]) return modelsMeta[model] as Record<string, unknown>;
      const formFields = (result.views?.form as Record<string, unknown>)?.fields;
      if (formFields) return formFields as Record<string, unknown>;
    } catch { /* fall through */ }
    return await this.execute(model, 'fields_get', [], {
      attributes: ['string', 'type', 'relation', 'required', 'readonly'],
    }) as Record<string, unknown>;
  }

  async checkAccess(model: string, operation: string): Promise<boolean> {
    try {
      return Boolean(await this.execute(model, 'check_access_rights', [operation, false]));
    } catch { return false; }
  }

  async validFieldNames(model: string): Promise<Set<string>> {
    const meta = await this.execute(model, 'fields_get', [], { attributes: ['string'] }) as Record<string, unknown>;
    return new Set(Object.keys(meta));
  }

  async getModelId(model: string): Promise<number | null> {
    const ids = await this.execute('ir.model', 'search', [[['model', '=', model]]]) as number[];
    return ids[0] ?? null;
  }

  async userGroupXmlids(): Promise<Set<string>> {
    if (this._groupXmlids) return this._groupXmlids;
    const uid = await this.getUid();
    const rows = await this.execute('res.users', 'read', [[uid]], { fields: ['groups_id'] }) as Array<{ groups_id: number[] }>;
    const groupIds: number[] = rows[0]?.groups_id ?? [];
    const xmlids = new Set<string>();
    if (groupIds.length) {
      const imdRows = await this.execute(
        'ir.model.data', 'search_read',
        [[['model', '=', 'res.groups'], ['res_id', 'in', groupIds]]],
        { fields: ['module', 'name'] },
      ) as Array<{ module: string; name: string }>;
      for (const row of imdRows) xmlids.add(`${row.module}.${row.name}`);
    }
    this._groupXmlids = xmlids;
    return xmlids;
  }

  /** Release session state. Call on shutdown. */
  close(): void {
    this._cookies.clear();
    this._session = null;
    this._groupXmlids = null;
  }
}
