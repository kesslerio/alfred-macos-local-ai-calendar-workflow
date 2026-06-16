import { z } from "zod";
import { execSync } from "child_process";
import * as path from "path";

// 1. Zod Schema
const CalendarEventSchema = z.object({
  intent: z.enum(["create", "update", "delete", "search"]),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  calendar_hint: z.string(),
  needs_confirmation: z.boolean(),
  search_query: z.string().optional()
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
   - Default is "Personal".
2. Event Title:
   - Extract the core summary as the title.
   - Clean the title: DO NOT include the calendar flags (like /personal, /work, /family) or time/duration phrases (like "tomorrow", "30 minutes", "5pm") in the event title.
3. Fallback start time:
   - If no start time (hour/minute) is specified, set the start time to 09:00:00 on the target date.`;

  const requestBody = {
    model: modelName,
    prompt: prompt,
    stream: false,
    format: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["create", "update", "delete", "search"] },
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        calendar_hint: { type: "string" },
        needs_confirmation: { type: "boolean" },
        search_query: { type: "string" }
      },
      required: ["intent", "title", "start", "end", "calendar_hint", "needs_confirmation"]
    },
    options: {
      temperature: 0.0
    }
  };

  const response = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody)
  });

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
}

// Search helper wrapper
function searchCalendarEvents(query: string): any[] {
  try {
    const output = execSync(`"${HELPER_PATH}" search --query "${query.replace(/"/g, '\\"')}"`, { encoding: "utf-8" });
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
  const modelName = process.env.OLLAMA_MODEL || "qwen3.5:4b";

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
      const event = await parseWithOllama(targetQuery, modelName);

      if (event.intent === "create") {
        printAlfredJSON([
          {
            title: `Confirm: Add "${event.title}"`,
            subtitle: `📅 ${formatDisplayDate(event.start)} to ${formatDisplayDate(event.end)} on "${MAP_CALENDAR(event.calendar_hint)}". Press Enter.`,
            arg: "confirm_create",
            valid: true,
            variables: {
              action: "confirm_create",
              event_title: event.title,
              event_start: event.start,
              event_end: event.end,
              event_calendar: MAP_CALENDAR(event.calendar_hint)
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
                event_calendar: MAP_CALENDAR(event.calendar_hint)
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
            event_calendar: MAP_CALENDAR(event.calendar_hint)
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

      printAlfredJSON([
        {
          title: `Confirm Update: "${oldTitle}" -> "${newTitle}"`,
          subtitle: `📅 New: ${formatDisplayDate(start || "")} on "${cal}". Press Enter.`,
          arg: "confirm_update",
          valid: true,
          variables: {
            action: "confirm_update",
            selected_event_id: selectedId,
            event_title: newTitle,
            event_start: start,
            event_end: end,
            event_calendar: cal
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
