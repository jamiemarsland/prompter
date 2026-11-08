import { clean, db, inboxFor, json, preflight, readScript, type Ctx } from "../_shared";

export async function GET(request: Request, { env, params }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  const row = await (await db(env)).prepare("SELECT * FROM scripts WHERE id = ? AND inbox = ?").bind(params.id, inbox).first();
  return row ? json({ script: row }) : json({ error: "Not found" }, 404);
}

export async function PUT(request: Request, { env, params }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  const s = clean(await readScript(request));
  if (!s.text) return json({ error: "Script text is empty." }, 400);
  await (await db(env))
    .prepare("UPDATE scripts SET title = ?, body = ?, updated_at = ? WHERE id = ? AND inbox = ?")
    .bind(s.title, s.text, Date.now(), params.id, inbox)
    .run();
  return json({ ok: true, id: params.id });
}

export async function DELETE(request: Request, { env, params }: Ctx) {
  const inbox = await inboxFor(request, env);
  if (inbox instanceof Response) return inbox;
  await (await db(env)).prepare("DELETE FROM scripts WHERE id = ? AND inbox = ?").bind(params.id, inbox).run();
  return json({ ok: true });
}

export const OPTIONS = preflight;
