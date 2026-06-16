import { execFileSync } from "child_process";
import * as path from "path";

const WORKFLOW_DIR = __dirname;
const HELPER_PATH = path.join(WORKFLOW_DIR, "local-calendar-helper");

function run() {
  const action = process.env.action || "";
  const selectedId = process.env.selected_event_id || "";
  const title = process.env.event_title || "";
  const start = process.env.event_start || "";
  const end = process.env.event_end || "";
  const cal = process.env.event_calendar || "Personal";

  const location = process.env.event_location || "";
  const url = process.env.event_url || "";
  const notes = process.env.event_notes || "";
  const recFreq = process.env.event_recurrence_frequency || "";
  const recInterval = process.env.event_recurrence_interval || "";
  const recDays = process.env.event_recurrence_days || "";

  // Pass metadata as discrete argv entries so /bin/sh never expands $, backticks,
  // or $(...) inside user-provided values.
  const extraArgs: string[] = [];
  if (location) extraArgs.push("--location", location);
  if (url) extraArgs.push("--url", url);
  if (notes) extraArgs.push("--notes", notes);
  if (recFreq) extraArgs.push("--recurrence-frequency", recFreq);
  if (recInterval) extraArgs.push("--recurrence-interval", recInterval);
  if (recDays) extraArgs.push("--recurrence-days", recDays);

  try {
    if (action === "confirm_create") {
      const output = execFileSync(HELPER_PATH, [
        "create",
        "--title", title,
        "--start", start,
        "--end", end,
        "--calendar", cal,
        ...extraArgs
      ], { encoding: "utf-8" });
      console.log(output.trim());
      return;
    }

    if (action === "confirm_update") {
      const output = execFileSync(HELPER_PATH, [
        "update",
        "--id", selectedId,
        "--title", title,
        "--start", start,
        "--end", end,
        "--calendar", cal,
        ...extraArgs
      ], { encoding: "utf-8" });
      console.log(output.trim());
      return;
    }

    if (action === "confirm_delete") {
      const output = execFileSync(HELPER_PATH, ["delete", "--id", selectedId], { encoding: "utf-8" });
      console.log(output.trim());
      return;
    }

    console.log("Error: Invalid action: " + action);
  } catch (e: any) {
    console.log("Error performing calendar mutation: " + (e.message || String(e)));
  }
}

run();
