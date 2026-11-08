# Prometheus

Live pair sculpting with an AI agent — **https://prometheus.omnidynamics.dev**

Start from Blender's default cube and sculpt it together with an agent (Gemini 3.5 Flash Lite) that
watches the model from six fixed views, compares recent frames to infer where you're going, and
sculpts alongside you with the same brushes you have. A demo: the sculpture lives only in the tab
and downloads as GLB / OBJ / STL.

## Architecture

| Piece | Where | What |
|---|---|---|
| Studio (browser) | `src/client/sculpt/` | three.js + three-mesh-bvh. Welded 80×80-per-face cube, Blender-style brushes (draw, clay, inflate, smooth, flatten, pinch, crease, grab), X symmetry, undo, export. Written fresh, not ported from Blender (GPL). |
| Wall (browser) | `src/client/wall/` | vgpu/WebGPU plaster wall ported from omnidynamics (same material bake, window-light mask, light direction), plus the sculpture's cast shadow and an ember glow that breathes while the agent thinks and flares while it sculpts. CSS wall fallback without WebGPU. |
| Worker | `src/worker/index.ts` | Passkey auth + `/api/*`. Static assets served directly. |
| `Studio` DO (singleton) | `src/worker/do/studio.ts` | Passkeys (same enrollment-token + WebAuthn flow as mythosengine, `ENROLLMENT_TOKEN` = mythosengine's `CONSOLE_ENROLLMENT_TOKEN`) and the long-term memory. |
| `Gate` DO (singleton) | `src/worker/do/gate.ts` | The **only** Gemini caller. Evenly spaced slots (12 rpm target ⇒ one call every 5 s, under the 15 rpm limit), rolling-minute TPM check against 250K, 500 RPD with a reserve for human asks, Pacific-midnight reset, honours upstream 429 retry delays. |
| `Atelier` DO (per tab) | `src/worker/do/atelier.ts` | The agent harness for one session: short-term memory, then deletes itself 20 min after the last turn (or immediately when the tab closes). |

### Agent harness (`src/worker/agent/`)

- **One request per turn**, `tool_choice: "any"`, parallel tool calls: `sculpt_stroke` (polyline on a named view panel,
  replayed in the browser by raycasting from that view's camera), `update_intent`, `say`, `set_working_notes`,
  `rewrite_long_term_memory`, `use_skill`, `wait`. The result of a turn is observed through the next turn's frames.
- **What it sees:** the current 3×2 contact sheet (front/right/back/left/top/¾, labelled grid) at medium resolution,
  the recent frames at low resolution, recent strokes (human and agent), geometry summary with change hotspots.
- **Short-term memory:** a sliding window of the last 3 frames, each captioned with what happened after it,
  plus working notes, intent, plan and recent dialogue. Replaced every turn.
- **Long-term memory:** one block capped at 1,200 characters that the agent *rewrites* (consolidates) rather than appends to.
- **Skills:** small playbooks (blockout, head, creature, hard-surface, cleanup, follow). Only their one-line index is
  always in context; bodies load when triggered by your words or by `use_skill` (max 2 active).
- **Modes:** Lead (drives toward the target), Follow (continues/mirrors/cleans beside you), Watch (comments only), Off.

## Deploy

Push to `main` → `.github/workflows/ci.yml`: typecheck, test, build, `wrangler deploy`, sync Worker secrets
(`GEMINI_API_KEY`, `ENROLLMENT_TOKEN` from repo secrets; `SESSION_SIGNING_KEY` generated once), attach the custom domain
through the Workers Domains API, smoke test. Repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`GEMINI_API_KEY`, `ENROLLMENT_TOKEN`.

Token permissions: **Account › Workers Scripts › Edit** deploys everything (no D1/KV/R2). Attaching the domain also needs
**Zone › Zone › Read**, **Zone › Workers Routes › Edit** and **Zone › DNS › Edit** on `omnidynamics.dev`; without them that
step warns and you can bind it once by hand (Workers › prometheus › Settings › Domains & Routes › Custom domain).

Passkeys are bound to the host, so enrol once on each host you use (workers.dev and the custom domain; 3 slots).

## Local

```sh
npm install
# .dev.vars: GEMINI_API_KEY, SESSION_SIGNING_KEY (base64url 32 bytes), ENROLLMENT_TOKEN,
#            DEV_BYPASS_AUTH=1 (skips passkeys, honoured only on localhost)
npm run preview      # vite build + wrangler dev on :8787
npm test && npm run typecheck
```
