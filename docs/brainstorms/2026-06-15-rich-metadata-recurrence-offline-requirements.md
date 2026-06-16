---
date: 2026-06-15
topic: rich-metadata-recurrence-offline
mode: repo-grounded
---

# Requirements: Rich Metadata, Recurrence, and Resilient Offline Parsing

## Summary
A requirements document to extend the Local AI Calendar workflow. It introduces support for event location, notes, and URL metadata fields, native recurrence rules mapping to `EKRecurrenceRule` in Apple Calendar, an automatic offline natural language parsing fallback using `chrono-node` when the local Ollama server is offline or timing out, and semantic calendar auto-selection based on event titles.

## Problem Frame
Currently, the Local AI Calendar workflow is limited to basic titles, start dates, and end dates, missing essential features like event location and recurrence settings. Furthermore, the workflow depends strictly on local Ollama availability. If the local Ollama process is sleeping, loading, or not started, the user faces workflow silence or unhandled connection exceptions. Finally, users must manually append slash tags (like `/work`) to route events to the correct calendars, increasing typing friction.

## Key Decisions
- **Unified Upgrade Package:** Combine recurrence, location, notes, URLs, offline fallback, and semantic calendar matching into a single release cycle to minimize configuration overhead.
- **Dynamic Resilient Fallback:** Automatically fall back to parsing queries with `chrono-node` when the local Ollama connection times out or fails.
- **Core Recurrence Rules:** Target standard frequencies (daily, weekly, monthly, yearly) and simple days of the week (e.g. "every Monday", "monthly on the 15th").
- **Semantic Calendar Selection:** Let the LLM predict the most appropriate calendar name based on the semantic context of the event title, using explicit slash flags (e.g. `/work`) only as manual overrides.

## Requirements

### Rich Metadata (Location, Notes, URL)
- R1. The Ollama JSON schema in `parse_query.ts` must include optional fields for `location` (string), `url` (string), and `notes` (string).
- R2. The Swift helper `main.swift` must accept `--location`, `--url`, and `--notes` CLI arguments for both `create` and `update` commands.
- R3. The Swift helper must bind the parsed location, URL, and notes properties directly to the `EKEvent` object before saving.

### Event Recurrence
- R4. The Ollama JSON schema in `parse_query.ts` must include an optional `recurrence` object containing `frequency` (enum: daily, weekly, monthly, yearly), `interval` (integer), and `days_of_week` (array of strings).
- R5. The Swift helper `main.swift` must accept `--recurrence-frequency`, `--recurrence-interval`, and `--recurrence-days` CLI arguments.
- R6. The Swift helper must construct an `EKRecurrenceRule` from the parsed arguments and attach it to the `EKEvent` object before saving.

### Resilient Offline Parsing
- R7. The `parse_query.ts` script must wrap the Ollama fetch call in a connection timeout/error handler.
- R8. If the fetch call fails or times out, the script must parse the query using `chrono-node` to extract the event title, start date, and end date.
- R9. In offline fallback mode, the script must map calendars to the default "Personal" calendar and mark the event as `needs_confirmation: false`.

### Semantic Calendar Auto-Selection
- R10. The Ollama prompt in `parse_query.ts` must instruct the model to analyze the semantics of the event title and predict the most likely target calendar (e.g. "dentist appointment" -> "Personal", "client sync" -> "martin@shapescale.com") when no explicit slash flag is provided.
- R11. The TS coordinator must check if a user explicitly provided a calendar override flag (e.g. `/work` or `/family`) and, if so, override the LLM's semantically predicted calendar.

### Alfred UI Confirmation
- R12. The Alfred preview card subtitle must dynamically list the location, URL, recurrence, and target calendar details if present (e.g. `📅 Mon, Jun 15, 9:00 AM (Weekly) 📍 Room 4B 🔗 zoom.us 📂 martin@shapescale.com`).

## Acceptance Examples
- AE1. **Covers R1, R2, R3.** When query is `"sync at Room 4B http://zoom.us"`, the LLM parses `location: "Room 4B"` and `url: "http://zoom.us"`, and the event is created in Calendar with those fields populated.
- AE2. **Covers R4, R5, R6.** When query is `"weekly team sync every monday at 9am"`, the LLM parses `recurrence: { frequency: "weekly", interval: 1, days_of_week: ["monday"] }`, and a weekly recurring event is saved in Apple Calendar.
- AE3. **Covers R7, R8, R9.** When Ollama is offline, the query `"meeting tomorrow 3pm"` returns an instant Alfred result with the parsed date using the Chrono-Node fallback.
- AE4. **Covers R10, R11.** When query is `"sync with marketing tomorrow 10am"`, the LLM predicts calendar name `"martin@shapescale.com"` based on semantic analysis of `"sync with marketing"`, routing it appropriately without requiring a `/work` tag.

## Scope Boundaries
- **Deferred for later:** Interactive editing of location/URL fields inside Alfred, complex recurrence rules (e.g. "second Tuesday of every month"), custom calendar color/tag creation.
- **Outside this product's identity:** Supporting cloud API calendar targets, importing/syncing third-party calendar accounts.

## Dependencies / Assumptions
- **Dependency:** `chrono-node` package must be added to `package.json`.
- **Assumption:** Users have installed the latest version of Bun to resolve the `chrono-node` module.

## Sources / Research
- **Swift EventKit Reference:** [EventKit Framework - Apple Developer Documentation](https://developer.apple.com/documentation/eventkit)
- **Chrono-Node Parser:** [chrono-node library on GitHub](https://github.com/wanasit/chrono)
