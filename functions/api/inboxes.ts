import { db, hashKey, json, newKey, preflight, type Ctx } from "./_shared";

const PER_HOUR = 500; // site-wide brake on inbox creation

// POST /api/inboxes — create a private inbox. The key is returned once; only its hash is stored.
export async function POST(_request: Request, { env }: Ctx) {
  const d = await db(env);
  const recent = await d.prepare("SELECT COUNT(*) AS n FROM inboxes WHERE created_at > ?").bind(Date.now() - 3_600_000).first();
  if (Number(recent?.n) >= PER_HOUR) return json({ error: "Lots of new prompters right now. Try again in a little while." }, 429);
  const key = newKey();
  await d.prepare("INSERT INTO inboxes (id, created_at) VALUES (?, ?)").bind(await hashKey(key), Date.now()).run();
  return json({ key }, 201);
}

export const OPTIONS = preflight;
