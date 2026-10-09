import { z } from "zod";
import { execFileSync } from "child_process";
import * as path from "path";
import * as chrono from "chrono-node";

// 1. Zod Schema
const CalendarEventSchema = z.object({
  intent: z.enum(["create", "update", "delete", "search"]),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  calendar_hint: z.string(),
  needs_confirmation: z.boolean(),
  search_query: z.string().optional(),
  location: z.string().optional(),
  url: z.string().optional(),
  notes: z.string().optional(),
  recurrence: z.object({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive().optional(),
    days_of_week: z.array(z.string()).optional()
  }).optional()
});

type CalendarEvent = z.infer<typeof CalendarEventSchema>;

const WORKFLOW_DIR = __dirname;
const HELPER_PATH = path.join(WORKFLOW_DIR, "local-calendar-helper");

// Calendar mapping rules
const MAP_CALENDAR = (hint: string): string => {
  const h = hint.toLowerCase();
  if (h.includes("work") || h.includes("martin@shapescale.com")) return "martin@shapescale.com";
  if (h.includes("family") || h.includes("mkesslerhk@googlemail.com")) return "mkesslerhk@googlemail.com";
  return "Personal";
};

// Formats date nicely for display
const formatDisplayDate = (isoStr: string): string => {
  try {
    const d = new Date(isoStr);
    return d.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
  } catch (e) {
    return isoStr;
  }
};

// Formats date/time local ISO with timezone offset
const toLocalISOString = (date: Date): string => {
  const tzOffsetMs = date.getTimezoneOffset() * 60000;
  const localDate = new Date(date.getTime() - tzOffsetMs);
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const offsetMins = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  const tzOffset = `${offsetSign}${offsetHours}:${offsetMins}`;
  return localDate.toISOString().slice(0, -5) + tzOffset;
};

// Formats a rich subtitle for the Alfred confirmation item
const formatAlfredSubtitle = (event: CalendarEvent): string => {
  const startStr = formatDisplayDate(event.start);
  const endStr = formatDisplayDate(event.end);
  // Show "start to end" so the parsed duration is visible before the event is created.
  let parts = [event.end ? `📅 ${startStr} → ${endStr}` : `📅 ${startStr}`];
  
  if (event.recurrence) {
    const freq = event.recurrence.frequency;
    const interval = event.recurrence.interval || 1;
    let freqLabel = freq.charAt(0).toUpperCase() + freq.slice(1);
    if (interval > 1) {
      freqLabel = `Every ${interval} ${freq === 'daily' ? 'days' : freq === 'weekly' ? 'weeks' : freq === 'monthly' ? 'months' : 'years'}`;
    }
    parts.push(`(${freqLabel})`);
  }
  
  if (event.location) {
    parts.push(`📍 ${event.location}`);
  }
  
  if (event.url) {
    parts.push(`🔗 ${event.url}`);
  }
  
  const calName = MAP_CALENDAR(event.calendar_hint);
  parts.push(`📂 ${calName}`);
  
  return parts.join(" ");
};

// Matches a slash flag only as a standalone, whitespace-delimited token so paths
// or words like "/workout", "/workshop", or a URL's "/family" segment never trigger.
const hasSlashFlag = (query: string, flag: string): boolean =>
  new RegExp(`(?:^|\\s)/${flag}(?=\\s|$)`, "i").test(query);

// Explicit calendar override check from query string
function getExplicitCalendarOverride(query: string): string | null {
  if (hasSlashFlag(query, "work")) return "martin@shapescale.com";
  if (hasSlashFlag(query, "family")) return "mkesslerhk@googlemail.com";
  if (hasSlashFlag(query, "personal")) return "Personal";
  return null;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// Deterministic recurrence detection. Small local models reliably miss
// named-weekday recurrence ("every monday"), so this backstop fills the
// recurrence object from the query when the model omits it.
function extractRecurrence(query: string): CalendarEvent["recurrence"] | undefined {
  const q = query.toLowerCase();
  const hasEvery = /\b(every|each)\b/.test(q);
  const everyOther = /\bevery other\b/.test(q) || /\bbi-?weekly\b/.test(q);
  const days = WEEKDAYS.filter(d => new RegExp(`\\b${d}s?\\b`).test(q));

  let frequency: "daily" | "weekly" | "monthly" | "yearly" | undefined;
  if (/\bdaily\b/.test(q) || (hasEvery && /\bday\b/.test(q))) frequency = "daily";
  else if (/\bweekly\b/.test(q) || /\bbi-?weekly\b/.test(q) || (hasEvery && /\bweek\b/.test(q))) frequency = "weekly";
  else if (/\bmonthly\b/.test(q) || (hasEvery && /\bmonth\b/.test(q))) frequency = "monthly";
  else if (/\b(yearly|annually)\b/.test(q) || (hasEvery && /\b(year|annual)\b/.test(q))) frequency = "yearly";
  else if (days.length > 0 && hasEvery) frequency = "weekly"; // "every monday"

  if (!frequency) return undefined;
  const recurrence: NonNullable<CalendarEvent["recurrence"]> = {
    frequency,
    interval: everyOther ? 2 : 1
  };
  if (frequency === "weekly" && days.length > 0) {
    recurrence.days_of_week = days;
  }
  return recurrence;
}

// Leading command verbs that signal a non-create intent in the offline fallback.
const FALLBACK_INTENT_VERBS: Record<string, "delete" | "update" | "search"> = {
  delete: "delete", remove: "delete", cancel: "delete",
  update: "update", change: "update", reschedule: "update", move: "update", edit: "update", rename: "update",
  search: "search", find: "search", show: "search", list: "search"
};

// Detects intent from the leading verb so a model outage cannot silently turn
// "delete dentist appointment" into a newly created event.
function detectFallbackIntent(query: string): "create" | "update" | "delete" | "search" {
  const firstWord = query.trim().toLowerCase().split(/\s+/)[0] || "";
  return FALLBACK_INTENT_VERBS[firstWord] || "create";
}

// Fallback parsing using chrono-node
function parseWithChrono(query: string): CalendarEvent {
  const intent = detectFallbackIntent(query);
  const parsedResults = chrono.parse(query);
  let startDate: Date;
  let endDate: Date;

  if (parsedResults.length > 0 && parsedResults[0].start) {
    startDate = parsedResults[0].start.date();
    endDate = parsedResults[0].end ? parsedResults[0].end.date() : new Date(startDate.getTime() + 60 * 60 * 1000);
  } else {
    startDate = new Date();
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(9, 0, 0, 0);
    endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  }

  let title = query;
  if (parsedResults.length > 0) {
    title = query.replace(parsedResults[0].text, "");
  }
  // Remove standalone slash flags (not substrings like "/workout") and clean double spaces
  title = title.replace(/(?:^|\s)\/(work|family|personal)(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();

  // For non-create intents, drop the leading command verb so the event-matching
  // search uses the event name rather than the command itself.
  if (intent !== "create") {
    const searchTitle = title
      .replace(/^(delete|remove|cancel|update|change|reschedule|move|edit|rename|search|find|show|list)\s+/i, "")
      .trim() || title;
    return {
      intent,
      title: searchTitle,
      start: toLocalISOString(startDate),
      end: toLocalISOString(endDate),
      calendar_hint: "Personal",
      needs_confirmation: false,
      search_query: searchTitle
    };
  }

  if (!title) {
    title = "New Event";
  }

  return {
    intent: "create",
    title,
    start: toLocalISOString(startDate),
    end: toLocalISOString(endDate),
    calendar_hint: "Personal",
    needs_confirmation: false
  };
}

// =============================================================================
// LLM routing — local fleet first, then M.A.M.A / John/Ofus remote, then offline
// =============================================================================
// Ollama has been retired. The calendar parser now uses the same LLM routing as
// voiceink_cleanup.py: probe the local fleet routes (TensorFold / Splash /
// MTPLX) in order and use the first that is up; otherwise fall back to the
// M.A.M.A route (qwen3.8-flash-next on the direct John/Ofus vLLM endpoint — the
// Kalliope router at 100.124.155.99:4000 defers to this direct route). If every
// LLM route is unreachable, drop to offline chrono parsing.
//
// Local route endpoints mirror the voiceink fleet so the same VOICEINK_*
// overrides apply everywhere. QFlash (mlx-serve :11234, the 4-bit
// Flash-Next MoE) is probed first — it answers the full prompt in ~0.1-3s.
// Splash (~1s) is next; TensorFold's dense 27B (~25-30s) trails for
// interactive parsing. NOTE: the order is deliberate and differs from
// voiceink_cleanup.py's (which probes qflash first for dictation cleanup):
// keep the faster-first order only while the model stays fast — swap to
// voiceink's exact order if behavior must stay identical across clients.
// The mlx-serve id comes from /v1/models at runtime; the env name matches
// voiceink's override (VOICEINK_QFLASH_BASE_URL).
// NOTE: the qflash probe intentionally matches voiceink's payload fields
// (chat_template_kwargs + reasoning_effort "none"); sending
// thinking_budget: 0 ALONE makes this server emit empty content. Do not
// simplify those fields away on this route.

const LOCAL_ROUTES: Array<{ name: string; base_url: string }> = [
  { name: "qflash", base_url: process.env.VOICEINK_QFLASH_BASE_URL || "http://127.0.0.1:11234/v1" },
  { name: "splash", base_url: process.env.VOICEINK_SPLASH_BASE_URL || "http://127.0.0.1:8100/v1" },
  { name: "tensorfold", base_url: process.env.VOICEINK_TENSORFOLD_BASE_URL || "http://127.0.0.1:8300/v1" },
  { name: "mtplx", base_url: process.env.VOICEINK_MTPLX_BASE_URL || "http://127.0.0.1:8201/v1" },
];

const MAMA_BASE_URL = process.env.JOHN_OFUS_BASE_URL || "http://john:8888/v1";
const MAMA_MODEL = process.env.JOHN_OFUS_MODEL || "qwen3.8-flash-next";

function getMamaApiKey(): string {
  // Alfred's script action may not source .zshenv, so read the key explicitly
  // if it is not already in the environment.
  if (process.env.JOHN_OFUS_API_KEY) return process.env.JOHN_OFUS_API_KEY;
  if (process.env.VOICEINK_MAMA_API_KEY) return process.env.VOICEINK_MAMA_API_KEY;
  try {
    const fs = require("fs");
    const os = require("os");
    const line = fs
      .readFileSync(os.homedir() + "/.zshenv", "utf8")
      .split("\n")
      .find((l) => l.startsWith("export VOICEINK_MAMA_API_KEY="));
    if (line) {
      return line
        .replace("export VOICEINK_MAMA_API_KEY=", "")
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  } catch (_) {
    /* ignore */
  }
  return "";
}

// Probe the local fleet routes in order; return the first that answers
// /v1/models with at least one model. Mirrors voiceink_cleanup's
// detect_local_backend().
async function detectLocalBackend(): Promise<{ name: string; base_url: string; model: string } | null> {
  for (const route of LOCAL_ROUTES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${route.base_url}/models`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      const model = json.data?.[0]?.id;
      if (model) return { name: route.name, base_url: route.base_url, model };
    } catch (_) {
      // Route down or timed out — try the next one.
    }
  }
  return null;
}

// Shared calendar-parsing system prompt (identical for local and remote routes).
function buildCalendarSystemPrompt(query: string): string {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const offsetMins = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  const tzOffset = `${offsetSign}${offsetHours}:${offsetMins}`;

  const tzOffsetMs = now.getTimezoneOffset() * 60000;
  const localISOTime = (new Date(now.getTime() - tzOffsetMs)).toISOString().slice(0, -5) + tzOffset;
  const currentDay = now.toLocaleDateString("en-US", { weekday: "long" });

  return `You are a calendar parsing assistant. Your task is to parse a natural language query into a structured JSON event block.
Current local date/time is: ${localISOTime} (Day of week: ${currentDay})
Query: "${query}"

Guidelines:
1. Mappings for calendar_hint:
   - If the query contains /personal -> calendar_hint is "Personal"
   - If the query contains /work -> calendar_hint is "martin@shapescale.com"
   - If the query contains /family -> calendar_hint is "mkesslerhk@googlemail.com"
   - If NO calendar slash flag is explicitly present in the query, predict the calendar_hint based on the semantics of the title:
     * Use "martin@shapescale.com" for work, corporate tasks, software development, code reviews, meetings, client syncs, business, or ShapeScale related matters.
     * Use "mkesslerhk@googlemail.com" for family, relatives, parents, spouse, kids, home repairs, or family dinners.
     * Use "Personal" for personal appointments (dentist, doctor, gym, haircut, personal hobbies, personal tasks).
     * Default fallback is "Personal".
2. Event Title:
   - Extract the core summary as the title.
   - Clean the title: DO NOT include the calendar flags (like /personal, /work, /family) or time/duration phrases (like "tomorrow", "30 minutes", "5pm") in the event title.
3. Fallback start time:
   - If no start time (hour/minute) is specified, set the start time to 09:00:00 on the target date.
4. Rich metadata:
   - Extract "location" (e.g. room, address, zoom/google meet URL) if specified.
   - Extract "url" if an event web link or zoom link is specified.
   - Extract "notes" ONLY for genuine extra description text. Leave "notes" empty if there is nothing extra.
   - NEVER place calendar slash flags (/work, /personal, /family) or time/duration phrases into "notes", "title", "location", or "url". They are routing/scheduling directives, not content.
5. Recurrence rules (IMPORTANT — do not skip):
   - If the query contains ANY repetition phrase ("every", "each", "weekly", "daily", "monthly", "yearly", "annually", "every other"), you MUST populate the "recurrence" object. Do not omit it.
     * "frequency": daily, weekly, monthly, or yearly.
     * "interval": 1 (default), or 2 for "every other"/"biweekly", etc.
     * "days_of_week": array of lowercase weekdays (e.g. ["monday", "wednesday"]) when specific days are named.
   - Examples:
     * "standup every monday 10am" -> recurrence: { "frequency": "weekly", "interval": 1, "days_of_week": ["monday"] }
     * "gym every other day" -> recurrence: { "frequency": "daily", "interval": 2 }
     * "rent due monthly" -> recurrence: { "frequency": "monthly", "interval": 1 }
   - If the query is a one-time event with no repetition phrase, omit "recurrence" entirely.
 6. Output format (IMPORTANT — match exactly):
    Respond with ONLY one JSON object. No markdown fences, no commentary, no extra keys.
    Use these EXACT key names; every field is required:
    {
      "intent": "create",
      "title": "<clean title>",
      "start": "<ISO 8601 with local tz offset, e.g. 2026-10-02T17:00:00-07:00>",
      "end": "<ISO 8601 with local tz offset>",
      "calendar_hint": "<calendar email, or Personal>",
      "needs_confirmation": true,
      "location": "",
      "url": "",
      "notes": ""
    }
    - "start" and "end" MUST use the keys exactly "start" and "end" (never "start_time" / "end_time").
    - "intent" is "create" for new events; use "update"/"delete"/"search" only when the query clearly targets an existing event.
    - "needs_confirmation" MUST be present and true for new events.
    - Add the "recurrence" object (rule 5) only when the event repeats.`;
}

// Defensive normalization of model output before strict Zod validation:
// tolerate start_time/end_time key aliases and supply safe defaults for
// fields the model occasionally drops. The prompt already pins the exact
// schema; this only guards against model drift.
function normalizeEventRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...raw };
  if (o.start === undefined && typeof o.start_time === "string") o.start = o.start_time;
  if (o.end === undefined && typeof o.end_time === "string") o.end = o.end_time;
  delete o.start_time;
  delete o.end_time;
  if (o.intent === undefined) o.intent = "create";
  if (o.needs_confirmation === undefined) o.needs_confirmation = true;
  return o;
}

// Generic OpenAI-compatible chat/completions call returning a validated
// CalendarEvent. Used by both local fleet routes and the M.A.M.A remote.
async function parseWithOpenAI(
  base_url: string,
  model: string,
  query: string,
  apiKey: string,
  timeoutMs: number,
): Promise<CalendarEvent> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const response = await fetch(`${base_url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildCalendarSystemPrompt(query) },
          { role: "user", content: `Query: "${query}"\nRespond ONLY with the JSON object. No markdown fences, no commentary.` },
        ],
        stream: false,
        temperature: 0.0,
        max_tokens: 1024,
        // Calendar parsing is a short extraction task; keep reasoning off so a
        // thinking model does not spend 20-40s on hidden tokens before the JSON.
        // Mirrors voiceink_cleanup's _reasoning_fields(thinking=False).
        reasoning_effort: "none",
        thinking_budget: 0,
        chat_template_kwargs: { enable_thinking: false, reasoning_effort: "none" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`LLM API error (${base_url}): ${response.status} ${response.statusText}`);
    }

    const resJson = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const responseText = (resJson.choices?.[0]?.message?.content || "").trim();
    if (!responseText) throw new Error("LLM returned empty response");

    // Some models wrap the JSON in markdown fences; strip them before parsing.
    const rawText = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const rawObj = JSON.parse(rawText);
    return CalendarEventSchema.parse(normalizeEventRaw(rawObj));
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Use the detected local fleet route with its own model.
// 45s timeout: the only local route that's normally up is the heavy
// TensorFold-27B, which needs ~25-30s for a full parse; a down route fails
// the /models probe in ~2s, and a stuck route still falls through to the
// fast M.A.M.A remote.
function parseWithLocal(backend: { base_url: string; model: string }, query: string): Promise<CalendarEvent> {
  return parseWithOpenAI(backend.base_url, backend.model, query, "", 45000);
}

// M.A.M.A remote: qwen3.8-flash-next on the direct John/Ofus vLLM endpoint.
function parseWithMama(query: string): Promise<CalendarEvent> {
  return parseWithOpenAI(MAMA_BASE_URL, MAMA_MODEL, query, getMamaApiKey(), 20000);
}

// LLM routing for one query: local fleet route first, then the M.A.M.A remote,
// then offline chrono. Returns the parsed event plus which route produced it.
// A local route that fails or times out falls through to the remote instead of
// dropping straight to offline.
async function parseEventWithLLMFallback(
  targetQuery: string,
): Promise<{ event: CalendarEvent; source: string }> {
  const backend = await detectLocalBackend();
  if (backend) {
    try {
      return { event: await parseWithLocal(backend, targetQuery), source: `local (${backend.name} ${backend.model})` };
    } catch (localErr) {
      console.warn(`[parse_query] local route ${backend.name} failed (${localErr}); trying M.A.M.A remote.`);
    }
  }
  try {
    return { event: await parseWithMama(targetQuery), source: "M.A.M.A (John/Ofus remote)" };
  } catch (mamaErr) {
    console.error(`[parse_query] no LLM route answered (${mamaErr}); using offline chrono parsing.`);
    return { event: parseWithChrono(targetQuery), source: "offline (chrono)" };
  }
}

// Search helper wrapper
function searchCalendarEvents(query: string): any[] {
  try {
    const output = execFileSync(HELPER_PATH, ["search", "--query", query], { encoding: "utf-8" });
    return JSON.parse(output.trim());
  } catch (e) {
    return [];
  }
}

// Alfred JSON formatter helper
function printAlfredJSON(items: any[]) {
  console.log(JSON.stringify({ items }, null, 2));
}

// MAIN STATE MACHINE
async function run() {
  const query = process.argv[2] || "";
  const action = process.env.action || "";

  try {
    // STATE 1: Default Typing State
    if (!action) {
      if (!query.trim()) {
        printAlfredJSON([
          {
            title: "Local AI Calendar",
            subtitle: "Type an event: e.g. tomorrow 5pm Lunch with Mom /family",
            valid: false
          }
        ]);
        return;
      }

      printAlfredJSON([
        {
          title: `Analyze: "${query}"`,
          subtitle: "Press Enter to parse with local AI and confirm.",
          arg: query,
          valid: true,
          variables: {
            action: "analyze",
            query: query
          }
        }
      ]);
      return;
    }

    // STATE 2: Analyze
    if (action === "analyze") {
      const targetQuery = process.env.query || query;
      const { event, source } = await parseEventWithLLMFallback(targetQuery);

      if (!source.startsWith("local")) {
        console.warn(`[parse_query] source: ${source}`);
      }

      // Explicit override check
      const explicitCal = getExplicitCalendarOverride(targetQuery);
      if (explicitCal) {
        event.calendar_hint = explicitCal;
      }

      // Recurrence handling applies only to new events. For update/delete/search
      // the title is a search key / model-chosen new name and a frequency word
      // (e.g. "reschedule the weekly standup") is an identifier, not a directive —
      // injecting recurrence or stripping the title there would corrupt the request.
      if (event.intent === "create") {
        // Deterministic recurrence backstop for repetition phrases the model missed.
        if (!event.recurrence) {
          const recurrence = extractRecurrence(targetQuery);
          if (recurrence) {
            event.recurrence = recurrence;
          }
        }
        // Strip leftover recurrence keywords from the model-produced title.
        if (event.recurrence) {
          event.title = event.title
            .replace(/\b(every other|every|each)\b/gi, " ")
            .replace(/\b(daily|weekly|monthly|yearly|annually|bi-?weekly)\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
        }
      }

      if (event.intent === "create") {
        printAlfredJSON([
          {
            title: event.needs_confirmation ? `Confirm: Add "${event.title}"` : `Add "${event.title}"`,
            subtitle: `${event.needs_confirmation ? "" : "⚡ Quick Add: "}${formatAlfredSubtitle(event)}`,
            arg: "confirm_create",
            valid: true,
            variables: {
              action: "confirm_create",
              event_title: event.title,
              event_start: event.start,
              event_end: event.end,
              event_calendar: MAP_CALENDAR(event.calendar_hint),
              event_location: event.location || "",
              event_url: event.url || "",
              event_notes: event.notes || "",
              event_recurrence_frequency: event.recurrence?.frequency || "",
              event_recurrence_interval: event.recurrence?.interval ? String(event.recurrence.interval) : "",
              event_recurrence_days: event.recurrence?.days_of_week ? event.recurrence.days_of_week.join(",") : ""
            }
          }
        ]);
        return;
      }

      if (event.intent === "update" || event.intent === "delete" || event.intent === "search") {
        const searchQuery = event.search_query || event.title;
        const candidates = searchCalendarEvents(searchQuery);

        if (candidates.length === 0) {
          printAlfredJSON([
            {
              title: `No matching events found for "${searchQuery}"`,
              subtitle: `Press Enter to create a new event "${event.title}" instead.`,
              arg: "confirm_create",
              valid: true,
              variables: {
                action: "confirm_create",
                event_title: event.title,
                event_start: event.start,
                event_end: event.end,
                event_calendar: MAP_CALENDAR(event.calendar_hint),
                event_location: event.location || "",
                event_url: event.url || "",
                event_notes: event.notes || "",
                event_recurrence_frequency: event.recurrence?.frequency || "",
                event_recurrence_interval: event.recurrence?.interval ? String(event.recurrence.interval) : "",
                event_recurrence_days: event.recurrence?.days_of_week ? event.recurrence.days_of_week.join(",") : ""
              }
            }
          ]);
          return;
        }

        // Show candidates as items
        const items = candidates.map(c => ({
          title: `${c.title} (on ${c.calendar})`,
          subtitle: `📅 ${formatDisplayDate(c.start_date)} - ${formatDisplayDate(c.end_date)}. Press Enter to ${event.intent === "delete" ? "Delete" : "Update"}.`,
          arg: event.intent === "delete" ? "confirm_delete" : "confirm_update_form",
          valid: true,
          variables: {
            action: event.intent === "delete" ? "confirm_delete" : "update_details",
            selected_event_id: c.id,
            selected_event_title: c.title,
            event_title: event.title,
            event_start: event.start,
            event_end: event.end,
            event_calendar: MAP_CALENDAR(event.calendar_hint),
            event_location: event.location || "",
            event_url: event.url || "",
            event_notes: event.notes || "",
            event_recurrence_frequency: event.recurrence?.frequency || "",
            event_recurrence_interval: event.recurrence?.interval ? String(event.recurrence.interval) : "",
            event_recurrence_days: event.recurrence?.days_of_week ? event.recurrence.days_of_week.join(",") : ""
          }
        }));
        printAlfredJSON(items);
        return;
      }
    }

    // STATE 3: Update Details Confirmation
    if (action === "update_details") {
      const selectedId = process.env.selected_event_id;
      const oldTitle = process.env.selected_event_title;
      const newTitle = process.env.event_title;
      const start = process.env.event_start;
      const end = process.env.event_end;
      const cal = process.env.event_calendar;

      const loc = process.env.event_location || "";
      const url = process.env.event_url || "";
      const notes = process.env.event_notes || "";
      const recFreq = process.env.event_recurrence_frequency || "";
      const recInterval = process.env.event_recurrence_interval || "";
      const recDays = process.env.event_recurrence_days || "";

      // Format a rich subtitle for the update confirmation card
      let parts = [`📅 New: ${formatDisplayDate(start || "")}`];
      if (recFreq) {
        parts.push(`(${recFreq.charAt(0).toUpperCase() + recFreq.slice(1)})`);
      }
      if (loc) parts.push(`📍 ${loc}`);
      if (url) parts.push(`🔗 ${url}`);
      parts.push(`📂 ${cal}`);

      printAlfredJSON([
        {
          title: `Confirm Update: "${oldTitle}" -> "${newTitle}"`,
          subtitle: parts.join(" "),
          arg: "confirm_update",
          valid: true,
          variables: {
            action: "confirm_update",
            selected_event_id: selectedId,
            event_title: newTitle,
            event_start: start,
            event_end: end,
            event_calendar: cal,
            event_location: loc,
            event_url: url,
            event_notes: notes,
            event_recurrence_frequency: recFreq,
            event_recurrence_interval: recInterval,
            event_recurrence_days: recDays
          }
        }
      ]);
      return;
    }

    // STATE 4: Confirm Delete
    if (action === "confirm_delete") {
      const selectedId = process.env.selected_event_id;
      const title = process.env.selected_event_title;

      printAlfredJSON([
        {
          title: `Confirm Deletion: "${title}"`,
          subtitle: `Are you sure? This will permanently delete this event. Press Enter.`,
          arg: "confirm_delete",
          valid: true,
          variables: {
            action: "confirm_delete",
            selected_event_id: selectedId,
            selected_event_title: title
          }
        }
      ]);
      return;
    }

  } catch (e: any) {
    printAlfredJSON([
      {
        title: "Error running local calendar workflow",
        subtitle: e.message || String(e),
        valid: false
      }
    ]);
  }
}

run();
