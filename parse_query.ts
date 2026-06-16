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

async function parseWithOllama(query: string, modelName: string): Promise<CalendarEvent> {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const offsetMins = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  const tzOffset = `${offsetSign}${offsetHours}:${offsetMins}`;

  const tzOffsetMs = now.getTimezoneOffset() * 60000;
  const localISOTime = (new Date(now.getTime() - tzOffsetMs)).toISOString().slice(0, -5) + tzOffset;
  const currentDay = now.toLocaleDateString("en-US", { weekday: "long" });

  const prompt = `You are a calendar parsing assistant. Your task is to parse a natural language query into a structured JSON event block.
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
   - If the query is a one-time event with no repetition phrase, omit "recurrence" entirely.`;

  const requestBody = {
    model: modelName,
    prompt: prompt,
    stream: false,
    // Keep the model resident so intermittent Alfred queries avoid repeated cold loads.
    keep_alive: "30m",
    format: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["create", "update", "delete", "search"] },
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        calendar_hint: { type: "string" },
        needs_confirmation: { type: "boolean" },
        search_query: { type: "string" },
        location: { type: "string" },
        url: { type: "string" },
        notes: { type: "string" },
        recurrence: {
          type: "object",
          properties: {
            frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
            interval: { type: "integer" },
            days_of_week: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["frequency"]
        }
      },
      required: ["intent", "title", "start", "end", "calendar_hint", "needs_confirmation"]
    },
    options: {
      temperature: 0.0
    }
  };

  const controller = new AbortController();
  // 15s allows a 12B model (e.g. gemma4:12b) to cold-load without falsely
  // tripping the offline fallback; warm parses still return in ~2-3s.
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    const resJson = (await response.json()) as { response?: string; thinking?: string };
    let responseText = (resJson.response || "").trim();
    if (!responseText && resJson.thinking) {
      responseText = resJson.thinking.trim();
    }
    
    // Parse and validate with Zod
    const rawObj = JSON.parse(responseText);
    return CalendarEventSchema.parse(rawObj);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
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
  const modelName = process.env.OLLAMA_MODEL || "gemma4:12b";

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
      let event: CalendarEvent;
      
      try {
        event = await parseWithOllama(targetQuery, modelName);
      } catch (e) {
        // Fallback to offline chrono parsing
        event = parseWithChrono(targetQuery);
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
