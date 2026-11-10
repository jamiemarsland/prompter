import { clean, db, inboxFor, json, newId, preflight, type Ctx, type Env } from "../api/_shared";
import { describeTake } from "../api/_takes";

// A minimal MCP server (Streamable HTTP, stateless JSON responses) so AI agents can
// send scripts with a single connector URL: https://<space>/mcp/<inbox key>
// (or https://<space>/mcp with "Authorization: Bearer <key>").

const INSTRUCTIONS = `This connector sends scripts to the user's teleprompter. A script you send appears on their prompter screen within a few seconds.
Write for speaking aloud: short sentences, conversational, no stage-y markdown. About 150 spoken words is one minute.
Formatting the prompter understands: a blank line between paragraphs; "## Heading" for a section; [square brackets] for delivery notes such as [smile] or [pause] (voice mode skips them); "//" for a breath. Avoid tables, links and emoji, and don't use bullet lists in a word-for-word script.
Talking points: if the user wants to speak in their own words rather than read (they ask for "talking points", "bullet points", "notes" or "an outline"), send a list with one "- " line per point and nothing else but optional "## " headings. Keep each point to a short phrase of key words, not a sentence, e.g. "- why Elgato's app frustrated me". The prompter shows one point at a time and moves on when it hears them start the next one.
After sending, tell the user the title and that it's on their prompter. To revise a script after feedback, use update_script with the same id instead of sending a new one.

The user can also record themselves on the prompter. list_takes and get_take describe those recordings so you can edit them: the file name, where it was saved, the moments they marked as flubs, and rough word timings. The video file itself is on the user's computer, not on this server. If you can read their files (for example in Claude Code), find it by name in the folder given, usually under ~/Movies or ~/Downloads; otherwise ask them to share it. Prefer takes marked as keepers.`;

const TOOLS = [
  {
    name: "send_script",
    title: "Send script to teleprompter",
    description: "Put a new script on the user's teleprompter. It appears on their screen within seconds.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title shown in the script library, e.g. 'Episode 12 intro'." },
        text: { type: "string", description: "The full script, written to be read aloud. For talking points, one \"- \" line per point instead." },
      },
      required: ["title", "text"],
    },
  },
  {
    name: "update_script",
    title: "Revise a script",
    description: "Replace the text (and optionally the title) of a script already on the teleprompter.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The script id returned by send_script or list_scripts." },
        title: { type: "string" },
        text: { type: "string", description: "The full revised script." },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "list_scripts",
    title: "List scripts",
    description: "List the most recent scripts on the teleprompter (id, title, when sent).",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many, default 10." } } },
  },
  {
    name: "list_takes",
    title: "List recorded takes",
    description: "List the user's recent recordings from the prompter: id, script, take number, length, file name, keeper star and flub count.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many, default 10." },
        script_id: { type: "string", description: "Only takes of this script." },
        keepers_only: { type: "boolean", description: "Only takes the user starred as keepers." },
      },
    },
  },
  {
    name: "get_take",
    title: "Get a take for editing",
    description: "Everything needed to edit one recording: where the video file is, the flub markers (timestamps where the user tripped up) and rough word-by-word timings against the script. Omit id for the latest take.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Take id from list_takes. Leave out for the most recent take." } } },
  },
  {
    name: "get_script",
    title: "Read a script",
    description: "Get the full text of one script.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

async function callTool(name: string, args: any, env: Env, origin: string, inbox: string) {
  const d = await db(env);
  if (name === "send_script") {
    const s = clean({ title: args?.title, text: args?.text, source: "ai" });
    if (!s.text) return text("The script text was empty.", true);
    const id = newId();
    const now = Date.now();
    await d.prepare("INSERT INTO scripts (id, inbox, title, source, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, inbox, s.title, s.source, s.text, now, now).run();
    const words = s.text.split(/\s+/).length;
    return text(`Sent "${s.title}" to the teleprompter (id ${id}, ${words} words, about ${Math.max(1, Math.round(words / 150))} min). It's live at ${origin}/app/#${id}`);
  }
  if (name === "update_script") {
    const row = await d.prepare("SELECT title FROM scripts WHERE id = ? AND inbox = ?").bind(String(args?.id || ""), inbox).first();
    if (!row) return text("No script with that id.", true);
    const s = clean({ title: args?.title || row.title, text: args?.text });
    if (!s.text) return text("The script text was empty.", true);
    await d.prepare("UPDATE scripts SET title = ?, body = ?, updated_at = ? WHERE id = ? AND inbox = ?").bind(s.title, s.text, Date.now(), args.id, inbox).run();
    return text(`Updated "${s.title}". If it's open on the prompter, the new version appears within a few seconds and keeps the user's place. If they're reading or recording, it loads when they pause.`);
  }
  if (name === "list_scripts") {
    const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));
    const { results } = await d.prepare(`SELECT id, title, source, created_at FROM scripts WHERE inbox = ? ORDER BY created_at DESC LIMIT ${limit}`).bind(inbox).all();
    if (!results.length) return text("No scripts yet.");
    return text(results.map((r: any) => `${r.id} · ${r.title} · ${new Date(Number(r.created_at)).toISOString().slice(0, 16).replace("T", " ")} UTC`).join("\n"));
  }
  if (name === "get_script") {
    const row = await d.prepare("SELECT * FROM scripts WHERE id = ? AND inbox = ?").bind(String(args?.id || ""), inbox).first();
    return row ? text(`# ${row.title}\n\n${row.body}`) : text("No script with that id.", true);
  }
  if (name === "list_takes") {
    const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));
    const where = ["inbox = ?"], binds: unknown[] = [inbox];
    if (args?.script_id) { where.push("script_id = ?"); binds.push(String(args.script_id)); }
    if (args?.keepers_only) where.push("kept = 1");
    const { results } = await d.prepare(`SELECT * FROM takes WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`).bind(...binds).all();
    if (!results.length) return text("No takes recorded yet. The user records them on the prompter with the camera button.");
    return text(results.map((r: any) => describeTake(r, false)).join("\n\n"));
  }
  if (name === "get_take") {
    const row = args?.id
      ? await d.prepare("SELECT * FROM takes WHERE id = ? AND inbox = ?").bind(String(args.id), inbox).first()
      : await d.prepare("SELECT * FROM takes WHERE inbox = ? ORDER BY created_at DESC LIMIT 1").bind(inbox).first();
    if (!row) return text(args?.id ? "No take with that id." : "No takes recorded yet.", true);
    let out = describeTake(row, true);
    if (row.script_id) {
      const s = await d.prepare("SELECT body FROM scripts WHERE id = ? AND inbox = ?").bind(row.script_id, inbox).first();
      if (s) out += `\n\nScript as written:\n${s.body}`;
    }
    return text(out);
  }
  return text(`Unknown tool ${name}.`, true);
}

async function handle(msg: Rpc, env: Env, origin: string, inbox: string) {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "prompter", title: "Prompter teleprompter", version: "1.2.0" },
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(msg.params?.name, msg.params?.arguments || {}, env, origin, inbox);
    default:
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

export async function POST(request: Request, { env, params }: Ctx) {
  const inbox = await inboxFor(request, env, params.splat);
  if (inbox instanceof Response) return inbox;
  let body: Rpc | Rpc[];
  try { body = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const origin = new URL(request.url).origin;
  const one = async (m: Rpc) => {
    if (m.id === undefined || m.id === null) return null; // notification
    try { return { jsonrpc: "2.0", id: m.id, result: await handle(m, env, origin, inbox) }; }
    catch (e: any) { return { jsonrpc: "2.0", id: m.id, error: { code: e.code || -32603, message: e.message } }; }
  };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(one))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await one(body);
  return out ? json(out) : new Response(null, { status: 202 });
}

// No server-initiated stream; tell clients so they don't hold a GET open.
export async function GET(request: Request, { env, params }: Ctx) {
  if (request.headers.get("accept")?.includes("text/event-stream")) return new Response(null, { status: 405, headers: { allow: "POST" } });
  const inbox = await inboxFor(request, env, params.splat);
  return new Response(!(inbox instanceof Response)
    ? "Prompter MCP server. Add this URL as a connector in your AI app."
    : "Prompter MCP server. This URL needs your key.", { headers: { "content-type": "text/plain" } });
}

export async function DELETE() { return new Response(null, { status: 405 }); }

export const OPTIONS = preflight;
