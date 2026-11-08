import { db, inboxFor, json, preflight, type Ctx } from "../_shared";

export async function GET(request: Request, { env, params }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  const row = await (await db(env)).prepare("SELECT * FROM takes WHERE id = ? AND inbox = ?").bind(params.id, inbox).first();
  return row ? json({ take: row }) : json({ error: "Not found" }, 404);
}

// PUT {"kept": true} — star or unstar a take.
export async function PUT(request: Request, { env, params }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  const body = await request.json().catch(() => ({}));
  await (await db(env)).prepare("UPDATE takes SET kept = ? WHERE id = ? AND inbox = ?").bind(body?.kept ? 1 : 0, params.id, inbox).run();
  return json({ ok: true });
}

export async function DELETE(request: Request, { env, params }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  await (await db(env)).prepare("DELETE FROM takes WHERE id = ? AND inbox = ?").bind(params.id, inbox).run();
  return json({ ok: true });
}

export const OPTIONS = preflight;
