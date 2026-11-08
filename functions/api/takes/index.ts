import { db, inboxFor, json, newId, preflight, type Ctx } from "../_shared";
import { cleanTake } from "../_takes";

// GET /api/takes — newest 60 takes, without the word timings.
export async function GET(request: Request, { env }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  const { results } = await (await db(env))
    .prepare("SELECT id, script_id, title, n, filename, folder, duration_ms, size, kept, created_at FROM takes WHERE inbox = ? ORDER BY created_at DESC LIMIT 60")
    .bind(inbox)
    .all();
  return json({ takes: results });
}

// POST /api/takes — the prompter records a take's details (never the video itself).
export async function POST(request: Request, { env }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Send JSON." }, 400); }
  const t = cleanTake(body);
  if (!t.filename) return json({ error: "filename is required." }, 400);
  const id = newId();
  await (await db(env))
    .prepare("INSERT INTO takes (id, inbox, script_id, title, n, filename, folder, duration_ms, size, kept, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, inbox, t.script_id, t.title, t.n, t.filename, t.folder, t.duration_ms, t.size, t.kept, t.detail, Date.now())
    .run();
  return json({ ok: true, id }, 201);
}

export const OPTIONS = preflight;
