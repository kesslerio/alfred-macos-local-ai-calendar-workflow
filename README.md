# 📅 Local AI Calendar (Alfred 5 Workflow)

An ultra-fast, privacy-first natural language calendar assistant for Alfred 5. It parses calendar instructions with your local LLM fleet (QFlash / Splash / TensorFold / MTPLX) — falling back to the M.A.M.A remote route when no local route is up — and interacts directly with the macOS Calendar database using Apple's official `EventKit` framework.

## 🚀 Features

* **🏎️ Low Latency:** Parses in ~1–2s on the M.A.M.A remote route (~15–20s on a local 27B), with thinking tokens disabled so the model emits the JSON directly instead of reasoning at length.
* **🧠 High Accuracy:** Resolves relative times (like "tomorrow 5pm" or "next Monday") relative to your active system clock and timezone.
* **🛡️ Privacy-First:** Prefers your local fleet routes; the remote M.A.M.A fallback carries only the single calendar query (never your calendar history or events).
* **⚡ EventKit Backend:** Uses a compiled Swift helper to interact directly with Apple Calendar, ensuring robust support for creating, searching, updating, and deleting events without slow AppleScript.
* **🔄 Interactive Confirmation Loop:** Uses Alfred variables to show event candidates and confirmation states before final mutations.

---

## 📋 Requirements

1. **Alfred 5** (with Powerpack to run workflows).
2. **[Bun](https://bun.sh/)** installed for fast TypeScript execution.
3. **A calendar LLM route** — the workflow probes in order and uses the first that answers:
   - **Local fleet:** QFlash (`http://127.0.0.1:11234/v1`, mlx-serve 4-bit Flash-Next MoE, probed first at ~0.1-3s), Splash (`:8100`, ~1s), TensorFold (`:8300`, dense 27B, ~25-30s), MTPLX (`:8201`) — same routes as `voiceink_cleanup.py`, so the same `VOICEINK_*` env overrides apply.
   - **M.A.M.A remote:** `qwen3.8-flash-next` on the direct John/Ofus vLLM endpoint (`http://john:8888/v1`, Tailscale hostname `john`) — the Kalliope router (`100.124.155.99:4000`) defers interactive traffic to this direct route.
   - **Offline:** `chrono-node` rule parsing, always available with no network.

   Overrides: `VOICEINK_QFLASH_BASE_URL`, `VOICEINK_TENSORFOLD_BASE_URL`, `VOICEINK_SPLASH_BASE_URL`, `VOICEINK_MTPLX_BASE_URL`, `JOHN_OFUS_BASE_URL`, `JOHN_OFUS_MODEL`, and `JOHN_OFUS_API_KEY` / `VOICEINK_MAMA_API_KEY` (remote key, read from `~/.zshenv` if unset).

---

## 📥 Installation

1. Download the latest `.alfredworkflow` package from the [Releases](https://github.com/kesslerio/alfred-macos-local-ai-calendar-workflow/releases) page.
2. Double-click the downloaded file to import it into Alfred.
3. Open Alfred Preferences and make sure at least one route is reachable: a local fleet route (QFlash/Splash/TensorFold/MTPLX) or the M.A.M.A remote key in `~/.zshenv`. The workflow auto-selects the best route.

---

## 💡 Usage

Trigger the workflow in Alfred using the `cal` keyword:

### 1. Create Event
* `cal tomorrow 5pm 30 minutes Walk at Green Hill Playground /personal`
* `cal Wed 9am client sync /work`
* `cal next monday 2pm family dinner /family`

### 2. Update Event
If the model detects an intent to update or edit, it will search your calendar for matching events and show them in Alfred. Select the event you want to edit and hit Enter.

### 3. Delete Event
Type a delete query (e.g. `cal delete Dentist appointment next Monday`). The workflow will search for candidates, prompt you to select the correct one, and safely delete it.

---

## ⚙️ Configuration Flags

By default, the workflow maps flags to the following calendars:
* `/personal` -> **"Personal"**
* `/work` -> **"martin@shapescale.com"**
* `/family` -> **"mkesslerhk@googlemail.com"**
* If no flag is provided, it defaults to **"Personal"**.

*(You can edit these mappings in `parse_query.ts` if your local calendar names differ).*
