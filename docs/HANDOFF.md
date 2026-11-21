# Handoff

Written for whoever picks this up next. It assumes you can read the code; it
exists to tell you what is done, what is not, and what not to break.

## What this is

An 8-ball pool game with a real physics engine, in the browser. Two things
matter and the order is deliberate:

1. **The physics is realistic.** Not "feels pool-like" — actually modelled:
   sliding and rolling friction separately, throw, spin transfer, cushion
   reaction that depends on spin, squirt on off-centre cue strikes.
2. **The presentation is minimal.** Flat 2D canvas, simple balls, small UI.

Stack: Vite + TypeScript, no UI framework, Canvas 2D only. Server: Node with
`ws`, no database.

```
npm install
npm run build          # client bundle into dist/
npx tsx server/index.ts    # game server, default port 8787
npx vitest run         # 42 tests
npx tsc --noEmit       # typecheck
```

Practice mode is entirely client-side (no server needed). Online mode needs the
server; open two browser tabs, create a room, join with the 4-character code.

## Layout

| Path | What lives there |
|---|---|
| `src/core/constants.ts` | Every physical constant. Ball radius/mass, friction, restitution, table dimensions, pocket mouth sizes. |
| `src/core/table.ts` | Cushion segments, jaw circles, pocket positions, `pocketAt()` |
| `src/core/physics.ts` | The solver. `simulate()`, `shoot()`, `newRack()`, event-driven frames |
| `src/core/rules.ts` | `judgeShot()` and state application. Fouls, groups, respot, win |
| `src/render/scene.ts` | Static table layer + `drawBall()`. All drawing |
| `src/app.ts` | App class: input, playback, modes. `window.__game` is the debug hook |
| `src/ui/spin.ts` | The spin picker |
| `server/game.ts` | Rooms, clock, validation. Authoritative |
| `shared/protocol.ts` | Wire messages |
| `test/` | physics, rules, visual, multiplayer |
| `tools/` | Headless renderers used to check visuals without a browser |

Build the game as `npm run build`; `tools/render.ts` writes preview PNGs to
`docs/preview/` for visual checks — that is how the table is verified without
opening a browser.

## How the physics works

It is not a fixed-timestep simulation. Each ball's motion is solved in closed
form and the simulator jumps to the next contact event:

- A ball slides while the contact-point slip `u` is non-zero, then rolls. Slip
  decays at `3.5 * mu_slide * g`, so `t_roll = |u| / (3.5 * mu_slide * g)`.
  Positions during sliding are closed-form in `t`, so no integration error.
- Collisions are impulses. The normal impulse goes through the centres and
  cannot change spin; a Coulomb-clamped *tangential* impulse at the contact
  point is what produces throw, spin transfer and english. This is why the spin
  behaves correctly through a break.
- Cushions contact at `RAIL_H = 0.27 * R` above centre, so topspin and backspin
  change the rebound angle the way they do on a real table.
- The cue strike is one offset impulse, which produces both `v` and `ω`, plus a
  squirt term: `angle = -offset * SQUIRT_PER_R`.
- Frames are recorded on demand, not at a fixed rate — contacts cluster, so
  frame spacing is uneven. `displayBalls()` in `app.ts` interpolates by
  timestamp for exactly this reason. Do not index frames by constant `dt`.

Units are SI: metres, seconds, kilograms. `BALL_R = 0.028575`, `BALL_M = 0.17`.
A table is 2.54 m by 1.27 m of playing surface.

Determinism matters: the rack has seeded jitter, so a break is reproducible.
Do not replace it with `Math.random()`.

## What is known broken

**Pocket geometry — the open bug.** The physics side is correct and tested; the
drawing is not right and has been rewritten several times without landing.

Current state in `src/render/scene.ts` (the `// --- pockets ---` block, roughly
line 196-290): each pocket draws an ambient-occlusion gradient at the mouth,
then a filled polygon from one jaw, out along the rail, round an outer corner,
to the other jaw, then a radial "depth" gradient, then a lip stroke.

Why it looks wrong: a real pocket is a *hole*, and the thing that sells a hole
is the cushion ends cut into it and visible against the dark. The current code
draws the hole **after** the cushions, so it paints over the cushion ends and
they read as chopped off rather than cut. Changing the hole's outline has not
helped because the outline is not the problem — the draw order is.

The fix that was never tried: draw in the order cloth → pocket holes →
cushions (ending at the jaws, with their end faces angled and shaded) → rail →
sights. That is a restructure of `buildTable()`, not a tweak to the polygon.

Physics side, for reference, is already consistent and should not be changed to
match the drawing: `pocketAt()` in `table.ts` captures a ball when its centre
passes the mouth — the diagonal between the two cushion ends for a corner, the
rail line between the ends for a side. There is a test asserting a ball fired
at a cushion stops exactly on the cushion line (`HALF_W - BALL_R`) and never
inside it.

Aimed-in test results, useful as a baseline: corners 4/4, side pockets 0/4 from
shallow angles — those four hit the rail first, which is correct behaviour, not
a bug.

## Constraints

- **Do not push.** The repo has a remote (`origin`) but has deliberately never
  been pushed. Commit locally only.
- **The server must stay light.** `ws` and nothing else. No database for live
  games; rooms are in memory.
- **The README must read like a student wrote it.** Plain language, honest
  "what is simplified" section, no emoji, no marketing voice. This is a
  portfolio piece.
- The rules are chosen before the game starts and travel with room creation.
  The server must know them; it re-simulates every shot rather than trusting
  the client.

## Verification habits that matter here

Visual changes cannot be checked by reasoning about code. Render and look:

```
npx tsx tools/render.ts        # writes docs/preview/*.png
node tools/browser-check.mjs   # loads the built app in Edge, reports console errors
```

The browser check uses `playwright-core` against the installed Edge. Run it
after any client change; it catches runtime errors that `tsc` does not.

`window.__game` is exposed on the page for poking at state from the console.

## Appendix: the Codex / DSH question

Separate from the game, and unresolved. If you are asked to make
`openai-codex` work as a chat model inside DeepSeek Harness, start here so you
do not repeat the dead ends.

What was established:

- The provider is registered through `@deepseek-ai/dsh-llm-pi-ai`, configured
  in `~/.dsh/profiles/desktop/cordis.patch.yml` under `providers`. Note the
  running app uses the **desktop** profile, not `web`.
- `openai-codex` is OAuth-only. In pi-ai's catalog it is
  `{ env: [], defaultBaseURL: "https://chatgpt.com/backend-api" }` — it never
  looks for an API key. Setting `apiKeyEnv` is what produces `MISSING_CREDENTIAL`.
- The provider **must be authorised before it advertises models**. With no
  credential it registers but advertises zero models, and every route to it
  fails with `not allowed` / `Provider is not configured`. Configuring model
  ids alone does not help — that was the mistake made repeatedly.
- pi-ai registers an authorization flow for every catalog provider via
  `ctx.authorization.registerFlow(...)`, but this DSH build has no UI that
  renders those flows. Settings → Account is DeepSeek-only; Settings → Models
  shows no sign-in control.
- The credential record format is `llm-pi-ai/<providerId>` with
  `kind: grant` and pi-ai's own OAuth payload stored verbatim, e.g.
  `{ type: oauth, access, refresh, expires }` in `~/.dsh/.credentials.yaml`.
  Seeding it from `~/.codex/auth.json` was tried; the route still advertised
  nothing, so the record alone is not sufficient (something caches or validates
  at load).
- The `@deepseek-ai/dsh-subagent-codex` bundle spawns the Codex app-server and
  is independent of the above. It is pinned to `@openai/codex@0.153.4` and the
  README states upgrading requires regenerating schema evidence. That pinned
  payload could not obtain a usable model from the service (every id rejected),
  while a global `@openai/codex@0.171.0` worked fine. Overriding the pin to
  0.171.0 made the subagent work, but puts it outside the documented
  compatibility baseline.
- Everything above was reverted. The profile is back to `providers: {}`, the
  bundle is removed, credentials untouched.

The only clean fix is upstream: expose the pi-ai authorization flows in the UI
so the OAuth grant can actually be created.
