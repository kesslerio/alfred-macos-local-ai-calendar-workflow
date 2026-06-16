import { execSync } from "child_process";
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

  let extraArgs = "";
  if (location) extraArgs += ` --location "${location.replace(/"/g, '\\"')}"`;
  if (url) extraArgs += ` --url "${url.replace(/"/g, '\\"')}"`;
  if (notes) extraArgs += ` --notes "${notes.replace(/"/g, '\\"')}"`;
  if (recFreq) extraArgs += ` --recurrence-frequency "${recFreq}"`;
  if (recInterval) extraArgs += ` --recurrence-interval "${recInterval}"`;
  if (recDays) extraArgs += ` --recurrence-days "${recDays}"`;

  try {
    if (action === "confirm_create") {
      const cmd = `"${HELPER_PATH}" create --title "${title.replace(/"/g, '\\"')}" --start "${start}" --end "${end}" --calendar "${cal.replace(/"/g, '\\"')}"${extraArgs}`;
      const output = execSync(cmd, { encoding: "utf-8" });
      console.log(output.trim());
      return;
    }

    if (action === "confirm_update") {
      const cmd = `"${HELPER_PATH}" update --id "${selectedId}" --title "${title.replace(/"/g, '\\"')}" --start "${start}" --end "${end}" --calendar "${cal.replace(/"/g, '\\"')}"${extraArgs}`;
      const output = execSync(cmd, { encoding: "utf-8" });
      console.log(output.trim());
      return;
    }

    if (action === "confirm_delete") {
      const cmd = `"${HELPER_PATH}" delete --id "${selectedId}"`;
      const output = execSync(cmd, { encoding: "utf-8" });
      console.log(output.trim());
      return;
    }

    console.log("Error: Invalid action: " + action);
  } catch (e: any) {
    console.log("Error performing calendar mutation: " + (e.message || String(e)));
  }
}

run();
