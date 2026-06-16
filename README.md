# 📅 Local AI Calendar (Alfred 5 Workflow)

An ultra-fast, privacy-first natural language calendar assistant for Alfred 5. It parses calendar instructions using a local LLM in Ollama and interacts directly with the macOS Calendar database using Apple's official `EventKit` framework.

## 🚀 Features

* **🏎️ Ultra-Low Latency:** Parses events in ~1.5 seconds by leveraging Ollama's schema-constrained structured output (skipping heavy thinking token generations).
* **🧠 High Accuracy:** Resolves relative times (like "tomorrow 5pm" or "next Monday") relative to your active system clock and timezone.
* **🛡️ Privacy-First:** Everything runs 100% locally. No calendar history or events are ever sent to external APIs.
* **⚡ EventKit Backend:** Uses a compiled Swift helper to interact directly with Apple Calendar, ensuring robust support for creating, searching, updating, and deleting events without slow AppleScript.
* **🔄 Interactive Confirmation Loop:** Uses Alfred variables to show event candidates and confirmation states before final mutations.

---

## 📋 Requirements

1. **Alfred 5** (with Powerpack to run workflows).
2. **[Ollama](https://ollama.com/)** running locally.
3. **[Bun](https://bun.sh/)** installed for fast TypeScript execution.
4. **Calendar Model:** We recommend pulling `qwen3.5:4b` or `gemma4:12b`:
   ```bash
   ollama pull qwen3.5:4b
   ```

---

## 📥 Installation

1. Download the latest `.alfredworkflow` package from the [Releases](https://github.com/kesslerio/local-ai-calendar-workflow/releases) page.
2. Double-click the downloaded file to import it into Alfred.
3. Open Alfred Preferences, click on the **Local AI Calendar** workflow, and configure your preferred **Ollama Model** (defaults to `qwen3.5:4b`).

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
