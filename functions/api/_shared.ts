// Shared helpers for the script inbox. Files starting with "_" are never routed.

export interface Env {
  DB: {
    prepare(sql: string): {
      bind(...values: unknown[]): any;
      run(): Promise<any>;
      all(): Promise<{ results: any[] }>;
      first(): Promise<any>;
    };
  };
  PROMPTER_KEY?: string;
}

export interface Ctx {
  params: Record<string, string>;
  env: Env;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-prompter-key",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

// Every script belongs to an inbox. An inbox is identified by its secret key; the database
// only ever stores the key's SHA-256, so a leaked dump can't be used to send or read scripts.

export async function hashKey(key: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Key from "Authorization: Bearer <key>", "X-Prompter-Key", "?key=" or a path segment (MCP).
export function keyFrom(request: Request, pathKey?: string): string {
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return pathKey || bearer || request.headers.get("x-prompter-key") || new URL(request.url).searchParams.get("key") || "";
}

const known = new Set<string>();

// Resolves the caller's inbox, or a 401 response.
export async function inboxFor(request: Request, env: Env, pathKey?: string): Promise<string | Response> {
  const key = keyFrom(request, pathKey);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return json({ error: "Missing or wrong key." }, 401);
  const inbox = await hashKey(key);
  if (known.has(inbox)) return inbox;
  const row = await (await db(env)).prepare("SELECT id FROM inboxes WHERE id = ?").bind(inbox).first();
  if (!row) return json({ error: "Missing or wrong key." }, 401);
  known.add(inbox);
  return inbox;
}

let ready = false;
export async function db(env: Env) {
  if (ready) return env.DB;
  const DB = env.DB;
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS scripts (
      id VARCHAR(40) PRIMARY KEY,
      title VARCHAR(300) NOT NULL,
      source VARCHAR(100) NOT NULL,
      body LONGTEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`
  ).run();
  await DB.prepare("CREATE TABLE IF NOT EXISTS inboxes (id VARCHAR(64) PRIMARY KEY, created_at BIGINT NOT NULL)").run();
  // Takes are recordings. The video stays on the person's computer; this is what an editing agent needs to find and cut it.
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS takes (
      id VARCHAR(40) PRIMARY KEY,
      inbox VARCHAR(64) NOT NULL,
      script_id VARCHAR(40),
      title VARCHAR(300) NOT NULL,
      n INT NOT NULL,
      filename VARCHAR(300) NOT NULL,
      folder VARCHAR(300),
      duration_ms BIGINT NOT NULL,
      size BIGINT,
      kept TINYINT NOT NULL DEFAULT 0,
      detail LONGTEXT,
      created_at BIGINT NOT NULL,
      INDEX takes_inbox (inbox, created_at)
    )`
  ).run();
  // v1 had a single shared inbox: add the owner column and hand old scripts to the PROMPTER_KEY inbox.
  try { await DB.prepare("ALTER TABLE scripts ADD COLUMN inbox VARCHAR(64)").run(); } catch { /* already there */ }
  try { await DB.prepare("CREATE INDEX scripts_inbox ON scripts (inbox, created_at)").run(); } catch { /* already there */ }
  if (env.PROMPTER_KEY) {
    const owner = await hashKey(env.PROMPTER_KEY);
    if (!(await DB.prepare("SELECT id FROM inboxes WHERE id = ?").bind(owner).first())) {
      await DB.prepare("INSERT INTO inboxes (id, created_at) VALUES (?, ?)").bind(owner, Date.now()).run();
    }
    await DB.prepare("UPDATE scripts SET inbox = ? WHERE inbox IS NULL").bind(owner).run();
  }
  ready = true;
  return DB;
}

export function newId(): string {
  const t = Date.now().toString(36);
  const r = crypto.getRandomValues(new Uint8Array(6));
  return t + Array.from(r, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 8);
}

const MAX_CHARS = 200_000;

// Bots send scripts in all sorts of shapes: JSON with text/script/body/content, or a raw text body.
export async function readScript(request: Request): Promise<{ title?: string; text?: string; source?: string }> {
  const type = request.headers.get("content-type") || "";
  const raw = await request.text();
  if (type.includes("json") || /^\s*\{/.test(raw)) {
    try {
      const o = JSON.parse(raw);
      const text = o.text ?? o.script ?? o.body ?? o.content ?? o.markdown;
      return { title: o.title ?? o.name, text: typeof text === "string" ? text : undefined, source: o.source ?? o.from };
    } catch {
      // fall through and treat as plain text
    }
  }
  if (type.includes("x-www-form-urlencoded")) {
    const f = new URLSearchParams(raw);
    return { title: f.get("title") ?? undefined, text: f.get("text") ?? f.get("script") ?? undefined, source: f.get("source") ?? undefined };
  }
  return { text: raw };
}

export function clean(input: { title?: string; text?: string; source?: string }) {
  const text = (input.text || "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_CHARS);
  const firstLine = text.split("\n").find((l) => l.trim()) || "Untitled";
  const title = String(input.title || firstLine.replace(/^#+\s*/, "")).trim().slice(0, 120) || "Untitled";
  const source = String(input.source || "grok").trim().slice(0, 40) || "grok";
  return { title, text, source };
}
