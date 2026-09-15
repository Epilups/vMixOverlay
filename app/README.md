# Floorball scoreboard overlay (vMix + Stream Deck)

Local Node server that holds the game state, serves an animated HTML overlay for vMix, an
operator control panel, and a plain-GET HTTP API so a Stream Deck can drive everything.
**Zero npm dependencies.** Node 18+.

```
cd app
npm start            # or: node server.js     (PORT=8712 by default)
```

- Control panel: <http://localhost:8712/control>
- Overlay for vMix: `http://localhost:8712/overlay`
- Overlay preview in a normal browser (adds a fake rink background): `/overlay?bg=1`

## vMix setup

1. **Add Input → More → Web Browser**
2. URL `http://localhost:8712/overlay`, size **1920 × 1080**, and tick the option that keeps
   the page transparent (the overlay draws nothing but the bar; the rest is alpha).
3. Put the input on an **Overlay channel** (1–4). Leave it on continuously — showing/hiding is
   done inside the page (`/api/overlay?show=…`), which animates the bar in and out.
   Using a vMix overlay-channel transition instead also works; then just leave the page shown.
4. If the overlay ever looks stale, right-click the input → Reload.

Fonts load from Google Fonts. If the vMix machine has no internet, drop the two `.woff2` files
into `public/` and swap the `<link>` in `overlay.html` for an `@font-face` block.

Logos: put PNGs (transparent, ~200×200) in `app/public/logos/` and set the path in the control
panel (`logos/home.png`). Missing/blank logo falls back to a striped placeholder cell.

## State model

`config.json` holds the defaults loaded at startup (team names, shortnames, colours, logo paths,
period length, penalty presets, `maxPenalties`). "Save as default" in the control panel writes
the current teams back to it. Everything else is in-memory per session.

Clock: server ticks at 100 ms and pushes state to every connected page over SSE, so overlay and
control never drift. The operator can start/stop, nudge by ±1 s / ±1 min, or type an exact value —
so an external timekeeping system can stay the source of truth if you prefer.
**Penalty timers only run while the game clock runs** (correct for floorball).

Penalties: **slots, not overlays.** One list per side; its index is the slot (1 = top box,
2 = the box below). All of it lives in one HTML page, so there is no per-timer vMix overlay to
wire up — the whole scoreboard, both teams' penalties included, is a single browser input.

The rules, all handled server-side so no key sequence can desync it:

| Case | Behaviour |
| --- | --- |
| Add penalty | appends to that side's list → lands in the first free slot |
| Add while both slots busy | **queued**: doesn't tick, isn't drawn, starts automatically the moment a slot frees |
| Slot 1 expires | row animates out, slot 2 **slides up** into slot 1, any queued penalty starts |
| Release early (goal against a short-handed team) | `penalty/end` with no args ends slot 1 — the one that would expire first |
| Release a specific one | `penalty/end` with `slot=2` (or the panel's End button, which uses the stable `id`) |
| Wrong time entered | `penalty/adjust` ±10 s, or `value=1:30` to set exactly; hitting 0 ends it |
| Called in the wrong order | `penalty/swap` exchanges slot 1 and 2 |
| Empty slot addressed | endpoint is a no-op and says so — it never deletes the wrong penalty |
| Clock stopped | all penalty timers stop with it |
| Period change / game reset | penalties survive a period change; `/api/reset` clears everything |

`maxPenalties` (default 2) is the number of drawn slots per side; raise it and the overlay simply
draws more rows. A hard cap of 6 per side stops runaway input.

## HTTP API

Every endpoint answers to a plain **GET** and returns JSON, so Stream Deck's HTTP-request /
website actions work with no plugin scripting. `team` is `home` or `away`.

| Endpoint | Params | Does |
| --- | --- | --- |
| `/api/state` | – | current state (JSON) |
| `/events` | – | SSE stream of state (used by the pages) |
| `/api/score` | `team`, `delta=±1` or `set=3` | change / set a score |
| `/api/clock` | `action=start\|stop\|toggle\|reset` | run control |
| `/api/clock` | `action=set&value=12:47` (or seconds) | set exact time |
| `/api/clock` | `action=adjust&secs=-10` | nudge |
| `/api/period` | `delta=1` or `set=2`, `resetClock=1` | period |
| `/api/penalty/add` | `team`, `secs=120`, `label=` (optional) | add penalty (label defaults to the matching preset: 2 min / 4 min / 10 min) |
| `/api/penalty/end` | `team`, plus `slot=1\|2` or `id=` — none = slot 1 | release early |
| `/api/penalty/adjust` | `team`, `slot=`/`id=`, `secs=±10` or `value=1:30` | correct a running penalty |
| `/api/penalty/swap` | `team` (optionally `a=1&b=2`) | exchange two slots |
| `/api/penalty/clear` | `team` | wipe that team's penalties |
| `/api/overlay` | `show=1\|0\|toggle` | animate bar in / out |
| `/api/teams` | `homeShort=`, `awayName=`, `homeColor=`, `awayLogo=`, `swap=1` | live team edits |
| `/api/reset` | – | 0–0, clock reset, penalties cleared |
| `/api/config/save` | – | persist current teams to `config.json` |

## Stream Deck XL layout (32 keys)

Use the **HTTP Request** action (or "Website" with *open in background* if your version has it) —
one URL per key. No player numbers to type, so everything fits on **one page**:

```
HOME +1   HOME -1   HOME 2:00  HOME 4:00  HOME END 1  HOME END 2 | CLOCK ⏯   CLOCK -1s
AWAY +1   AWAY -1   AWAY 2:00  AWAY 4:00  AWAY END 1  AWAY END 2 | PERIOD +  CLOCK +1s
OVERLAY ⏯ HOME 10m  AWAY 10m   HOME -10s  HOME +10s               NEXT PER.  RESET GAME
```

- penalty keys → `/api/penalty/add?team=home&secs=120` (`240` for 4 min, `600` for 10 min)
- `END 1` → `/api/penalty/end?team=home&slot=1` (the one expiring first), `END 2` → `&slot=2`
- `±10s` → `/api/penalty/adjust?team=home&slot=1&secs=-10`
- pressing `END 2` when there is no second penalty does nothing — safe to mash.
- 22 of 32 keys used; the rest stay free for scenes, replay or audio.

Keyboard shortcuts also exist in the control panel: **space** clock, **Q/A** home ±1, **P/L** away ±1.

## Files

```
app/
  server.js          state, clock, REST API, SSE, static files
  config.json        defaults (teams, period length, penalty presets)
  public/
    overlay.html     the vMix overlay — layout 1a, animated, transparent
    control.html     operator panel
    logos/           drop team PNGs here
```

## Extending

- **New graphic** (goal card, power-play indicator, end-of-period banner): add a field to `state`,
  an endpoint in the `api()` switch, and markup + a CSS transition in `overlay.html`. The SSE
  stream carries it automatically.
- **Different animation**: everything is CSS — `#bar` slide-in, `.pen` `penIn`/`penOut`,
  `.score.pop`, and the `penFlash` pulse in the last 10 seconds. Change the easing/duration in one place.
- **Second overlay** (e.g. a corner bug): add `public/bug.html`, connect it to `/events`, add it
  as a second vMix browser input. Any number of pages can subscribe.
