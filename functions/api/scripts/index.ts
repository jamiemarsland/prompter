import { clean, db, inboxFor, json, newId, preflight, readScript, type Ctx } from "../_shared";

// GET /api/scripts — newest 60 scripts, without bodies.
export async function GET(request: Request, { env }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  const { results } = await (await db(env))
    .prepare(
      "SELECT id, title, source, created_at, updated_at, LENGTH(body) AS chars, SUBSTR(body, 1, 160) AS preview FROM scripts WHERE inbox = ? ORDER BY created_at DESC LIMIT 60"
    )
    .bind(inbox)
    .all();
  return json({ scripts: results });
}

// POST /api/scripts — what the Grok bot calls. Body: {"title": "...", "text": "..."} or plain text.
export async function POST(request: Request, { env }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  const s = clean(await readScript(request));
  if (!s.text) return json({ error: 'Send the script as JSON {"title", "text"} or as a plain-text body.' }, 400);
  const id = newId();
  const now = Date.now();
  await (await db(env))
    .prepare("INSERT INTO scripts (id, inbox, title, source, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, inbox, s.title, s.source, s.text, now, now)
    .run();
  const origin = new URL(request.url).origin;
  return json({ ok: true, id, title: s.title, url: `${origin}/app/#${id}` }, 201);
}

export const OPTIONS = preflight;
