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

## Talking points

Send a list with one `- ` line per point instead of a script, and Prompter treats it as talking points. In voice mode it shows one point at a time, ticks it off when it hears you cover it, and moves on when you start talking about the next one. Arrow keys or a click move between points by hand.

## Narration

Drop a video onto Prompter (or press the narrate button) to record a voiceover for it. The video plays muted above the script while only your voice is recorded, with voice following, talking points and flub markers working as usual. You review it as the video with your new voice over it. The audio saves to your takes folder with a `.json` notes file saying which video it belongs to and where in it the voice starts, and your AI gets the same details through `get_take`. The video never leaves your computer.

To watch the video before you record, press **Play** in the bar under it (or P). It plays with its own sound, and if the script is timed (see below) the words move along with the picture.

Once you've recorded a take, **Hear take** (or B) in the same bar plays your latest take over the video right there, with the words following, so you can check it lines up.

In a timed script the script and the video stay together while you're getting ready: scroll the words (or use the arrow keys) and the video jumps to that moment; drag the bar under the video and the words jump to what's due then.

### Auto-time

Press **✨ Auto-time** in the video bar and Prompter listens to the video's existing voiceover and writes where each paragraph of your script falls, so the words keep pace with the picture. With no script open, it writes one from what's said, already timed. A video from your computer has its sound boiled down in the browser to a small 16 kHz WAV before it's sent; a linked video is fetched by the speech service directly. Your AI can do the same with the `time_script` tool.

Speech recognition is [Groq](https://groq.com)'s Whisper (`whisper-large-v3-turbo`, word timestamps), paid for by the Space owner, so it only switches on when the Space has a `GROQ_API_KEY` variable:

```bash
pbpaste | sf env set GROQ_API_KEY --value-from-stdin --space prompter
```

Each inbox gets 30 minutes of audio a day (UTC), counted in `autotime_usage`.

### Enhanced audio

Each narration take is cleaned up right after you record it, in your browser: rumble is cut, background noise is removed with [RNNoise](https://github.com/xiph/rnnoise) (the WebAssembly build from [@shiguredo/rnnoise-wasm](https://github.com/shiguredo/rnnoise-wasm), Apache 2.0, in `app/vendor/`), the voice gets a gentle EQ and de-ess, its level is evened out, and the result is set to -16 LUFS with peaks under -1 dBFS. It saves as a 48 kHz WAV beside your original, which is always kept. The review's "Hearing: enhanced / original" button switches between them, and Hear take plays whichever you picked. Turn it off with "Enhance narration audio" in Settings. Nothing is uploaded.

### A video from a link

The narrate button also takes a link, as long as it points straight at a video file (one ending in `.mp4`, say) that opens without signing in. A YouTube or Vimeo page won't work. Prompter offers to keep the link with the script, as a paragraph of its own:

```
[video: https://example.com/film.mp4]
```

A script with that line opens with its video already loaded, on any device. An AI can set it with `video_url` on `send_script` or `update_script`. Prompter only stores the link, never the video, and a file you dropped in yourself is never replaced by a script's link.

### Timed sections

Start a paragraph with where it belongs in the video and it becomes a section:

```
[0:00-0:31] I asked for a better-looking cycling game. [0:14] Make it rain.

[0:36-1:08] To explain, we go back two days.
```

- `[m:ss]` or `[m:ss-m:ss]` at the start of a paragraph is the section's cue, and its end if you give one.
- `[m:ss]` inside a paragraph is a pace mark: the words after it are due at that moment.

With a video loaded, Record counts you in 3, 2, 1 and starts the video on the section you are at, then keeps recording to the end of the video (or until you stop). The "Record:" switch in the video bar changes that to just the section you are on, which stops a beat after the section ends; the review then offers "Keep, next section". The times stay out of sight on the prompter and show while you edit. A thin underline moves through the words to show where the picture expects you to be, and in Steady mode the script scrolls at that pace. `[` and `]` choose which section to start from, and "Sound" plays the video's own audio (wear headphones). Each take's file name, notes file and `get_take` details say which section it starts at.

## Remix it

Get your own copy running on Spacefast in one click, with its own database and inboxes:
[Remix Prompter](https://my.spacefast.com/new?git=https%3A%2F%2Fgit.spacefast.com%2Fjamie-team-3%2Fprompter)

## Ideas

See [IDEAS.md](IDEAS.md) for what might come next.

## Licence

MIT. See [LICENSE](LICENSE).
