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
| `Studio` DO (singleton) | `src/worker/do/studio.ts` | Passkeys (same enrollment-token + WebAuthn flow as mythosengine; its own `ENROLLMENT_TOKEN`). |
| `Gate` DO (singleton) | `src/worker/do/gate.ts` | The **only** Gemini caller. Evenly spaced slots (12 rpm target ⇒ one call every 5 s, under the 15 rpm limit), rolling-minute TPM check against 250K, 500 RPD with a reserve for human asks, Pacific-midnight reset, honours upstream 429 retry delays. |
| `Atelier` DO (per tab) | `src/worker/do/atelier.ts` | The agent harness for one session: short-term memory, then deletes itself 20 min after the last turn (or immediately when the tab closes). |

### Agent harness (`src/worker/agent/`)

Built on what has worked for VLM agents editing 3D: SceneCraft's render → critique → fix loop (its biggest ablation),
LL3M's planner/critic/verifier roles, 3DAxisPrompt's on-image axis overlays, and explicit coordinate mapping (SpatialMind/Think3D).

- **One request per turn**, `tool_choice: "any"`, parallel tool calls. Every turn begins with `assess`: observe each view,
  **verify last turn's predicted change** against the new frame, rank the gaps to the target, then predict this turn's
  visible change (checked next turn).
- **Big moves:** `add_shape` blends sphere / ellipsoid / capsule / box / cylinder / cone / torus into the clay (or carves them out)
  via a voxel remesh (SDF + marching cubes, like DynaMesh), which also re-evens topology. `sculpt_global` spherize / smooth /
  inflate / scale. `sculpt_form` is a 3D-addressed Move brush (pull/push/add/carve… at an object-space point).
- **Detail:** `sculpt_stroke` polylines on a named view panel, replayed by raycasting from that view's camera; `remesh`.
- **3D grounding:** fixed axes (Y up, model faces +Z, its left is +X), exact panel→object formulas, an axis gizmo and the
  panel half-extent drawn on every panel, and the form as numbers (nine horizontal slices with X/Z extents).
- **Doctrine:** primary → secondary → tertiary forms, silhouette (front + right) first, fuse added mass, check every view.
- **Modes:** **Lead** owns the piece: sets a target + milestones, iterates continuously (up to 24 actions/turn, sharpest sheet,
  5 recent frames, high thinking, 16K output) until it declares done; the Gate still spaces calls at 12/min.
  **Follow** extends/mirrors/cleans beside you (10 actions). **Watch** comments only. **Off.**
- **Memory:** short-term only — a sliding window of recent multi-view frames (3, or 5 in Lead) each captioned with what
  happened after it, plus the session's reading, target + milestones, plan and last critique/prediction. (A long-term memory
  block and working notes were tried and removed: the agent almost never used them.) **Skills** (blockout, head, creature,
  objects, hard-surface, cleanup, follow) load on demand.

You can add mass too: pick a shape in **Add mass**, then click the clay (Add or Carve); **Remesh** evens out stretched areas.

### Touch

Pointer Events with every active pointer cached (MDN multi-touch guidance), `touch-action: none` only on the canvas, and
gestures after Nomad Sculpt / tablet sculpting apps: one finger on the clay sculpts, one finger off it orbits; two fingers
pinch-zoom and pan; two-finger tap undo; three-finger tap redo; double-tap empty space resets the view. A second finger
landing within 180 ms of a stroke cancels that stroke, so starting a pinch never leaves a dent. Apple Pencil / pen pressure
scales strength. With any coarse pointer present, controls grow to ~44 px targets.

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
