# Prompter

Teleprompter at https://prompter.space.fast with a script inbox your Grok bot posts to.

- `index.html` – the whole app (voice + steady scrolling, appearance, library).
- `functions/api/scripts/` – Spacefast functions: `GET/POST /api/scripts`, `GET/PUT/DELETE /api/scripts/:id`. Rows live in the space's built-in database.
- `.prompter-key` – the inbox key (also stored as the `PROMPTER_KEY` env var on the space). Never publish it.
- `dev/mock.py` – local stand-in for the API (key `test`) for UI work: `python3 dev/mock.py .` then open http://localhost:8765.

Deploy: `./build.sh && sf publish dist`

Rotate the key: `openssl rand -hex 16 > .prompter-key && sf env set PROMPTER_KEY --value-from-stdin --space prompter < .prompter-key`

## AI connector (MCP)

`functions/mcp/[...rest].ts` is a stateless MCP server. Connector URL: `https://prompter.space.fast/mcp/<PROMPTER_KEY>` (or `/mcp` with a Bearer header). Tools: `send_script`, `update_script`, `list_scripts`, `get_script`. The UI's "Copy connector link" button copies it.

## Per-person inboxes

Anyone can click "Create my prompter" (`POST /api/inboxes`) to get a private key; scripts are scoped by `inbox` = SHA-256 of the key, so the database never stores raw keys. `PROMPTER_KEY` is just the original owner's inbox (old scripts were migrated to it). Creation is capped at 500 inboxes/hour site-wide.

## Takes (recordings)

The camera button records a take while the prompter scrolls. After each take a review panel offers Keep ★, Retake and Discard; pressing X while recording marks a flub.

Video never goes to the server (Spacefast app storage is capped at 5 MiB a file). In Chrome and Edge, Appearance › Save takes to picks a folder and every take is written there as soon as it stops; elsewhere Keep downloads it. The prompter then posts the take's details to `/api/takes`: file name, folder name, length, keeper star, flub times and rough word timings. The connector's `list_takes` and `get_take` tools give those to an editing agent, which finds the file on the user's computer by name.

## Remix it

Get your own copy running on Spacefast in one click, with its own database and inboxes:
[Remix Prompter](https://my.spacefast.com/new?git=https%3A%2F%2Fgit.spacefast.com%2Fjamie-team-3%2Fprompter)

## Licence

MIT. See [LICENSE](LICENSE).
