# Tittel Tutoring Whiteboard

A zero-login, ephemeral collaborative whiteboard for live tutoring. Click one button to spin up a
board, send the link to your students, and draw together instantly — no accounts, no installs. When
everyone leaves, the board disappears.

**You (the tutor) drive the view:** when you pan or zoom, every student's screen follows yours, so you
always know they're looking at exactly what you're drawing.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dinglequandale/tittel-tutoring-whiteboard)

One-click, free, no credit card. Gives you a permanent URL to bookmark and share.

## Features

- Pencil with variable thickness & color, eraser, shapes, text, selection
- **Undo / Redo** — `Ctrl+Z` / `Ctrl+Y`
- **Copy & paste**, including pasting an image or problem screenshot straight from your clipboard (`Ctrl+V`)
- **Right-click drag to pan** (tutor); plus pinch / scroll zoom
- **Synced viewport** — students are locked to the tutor's pan/zoom
- **Export** the board to PNG/SVG from the built-in menu (handy if a session is worth keeping)
- Live cursors so you can see where each student is pointing
- One-click shareable link, copied to your clipboard automatically

## How roles work (no auth needed)

- Clicking **"Start a new board"** sends *you* to `…/b/<id>#host`. The `#host` part stays in your
  browser only — it's never in the link you share. That makes you the tutor who drives the camera.
- Anyone who opens the shared link (`…/b/<id>`) joins as a **student**: they draw freely but their
  view is pinned to yours.

## Run it locally

```bash
npm install
npm run dev
```

Open <http://localhost:5173>, click **Start a new board**, then open the copied link in a second
window (or an incognito window) to play both sides. The Vite dev server proxies the realtime
WebSocket + asset endpoints to the Node server on port 5858.

### Production build (single port)

```bash
npm run build      # builds the client into client/dist
npm start          # serves client + realtime backend on http://localhost:5858
```

## Deploy (get a permanent shareable URL)

The whole app is **one Node service** (it serves the static client *and* the realtime backend), so it
deploys anywhere that supports Node + WebSockets.

### Render (recommended, free)

1. Push this folder to a GitHub repo.
2. On [Render](https://render.com): **New + → Blueprint**, pick the repo. It reads `render.yaml`
   (build: `npm install && npm run build`, start: `npm start`).
3. You get a URL like `https://tittel-whiteboard.onrender.com`. Bookmark it — that's your home base.
   Each click of **Start a new board** there produces a fresh per-session link to send students.

> Free tier note: the service sleeps after ~15 min idle and cold-starts in ~30s on the next visit.
> Fine for ephemeral use; upgrade to a paid instance to keep it always-warm.

### Alternatives

- **Fly.io** — `fly launch` (Node buildpack), ensure the internal port matches `PORT`. WebSockets work
  out of the box.
- **Cloudflare Tunnel / ngrok (zero deploy)** — run `npm run build && npm start` on your own machine,
  then `cloudflared tunnel --url http://localhost:5858` (or `ngrok http 5858`) to get a public link.
  The link only works while your machine is running it.

## Notes

- **Ephemeral by design.** Rooms live only in memory. ~30s after the last person leaves, the room and
  any pasted images are dropped. There is no database and nothing is written to disk.
- **tldraw watermark.** The board shows a small "made with tldraw" watermark on the free SDK license.
  To remove it, get a key from [tldraw.dev](https://tldraw.dev) and set `VITE_TLDRAW_LICENSE_KEY`
  (env var at build time, or in `render.yaml`).

## Smoke test

`node test/smoke.mjs` (with the server running on :5858) exercises the asset store, the tutor→student
camera relay, late-join camera replay, and the sync-socket wiring.

## Project layout

```
server/index.ts   http + WebSocket upgrades + asset store + camera relay + static serving
server/rooms.ts   in-memory room registry + ephemeral cleanup
client/src/Board.tsx       <Tldraw> + useSync + camera sync + right-click pan
client/src/cameraSync.ts   host broadcasts camera; guests lock + follow
client/src/Landing.tsx     "Start a new board" + link copy
client/src/assetStore.ts   uploads pasted images to the server
```
