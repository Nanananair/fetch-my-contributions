import { randomUUID } from "node:crypto";
import { input } from "@inquirer/prompts";
import type { Db } from "../db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const QUESTIONS = [
  "What did you do here that isn't in the data?",
  "Did it move a number? Which one, by how much?",
] as const;

/**
 * Weekly interactive check-in. Answers become first-class `manual` events
 * linked to their thread, so reports can quote real impact in the user's own
 * words instead of inventing it.
 */
export async function runCheckin(deps: { db: Db; now?: Date }): Promise<void> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const lastCheckin =
    db.getState("last_checkin") ??
    new Date(now.getTime() - 14 * DAY_MS).toISOString();

  const threads = db.getThreadsWithEvents(lastCheckin);
  if (threads.length === 0) {
    console.log(
      `No threads with activity since ${lastCheckin.slice(0, 10)}. Run \`fmc sync\` first.`
    );
    return;
  }

  console.log(
    `${threads.length} thread(s) active since ${lastCheckin.slice(0, 10)}. Press Enter to skip a question.\n`
  );

  let saved = 0;
  let aborted = false;
  outer: for (const { thread, events } of threads) {
    console.log(`\n■ ${thread.title}  (${thread.first_seen.slice(0, 10)}..${thread.last_seen.slice(0, 10)})`);
    for (const e of events.slice(-5)) {
      console.log(`    · ${e.timestamp.slice(0, 10)}  ${e.title}`);
    }

    for (const question of QUESTIONS) {
      let answer: string;
      try {
        answer = (await input({ message: question })).trim();
      } catch (err) {
        // Ctrl-C / closed stdin: keep what was answered, don't advance last_checkin.
        if ((err as Error).name === "ExitPromptError") {
          aborted = true;
          break outer;
        }
        throw err;
      }
      if (!answer) continue;
      const eventId = `manual:${randomUUID()}`;
      db.insertEvent({
        id: eventId,
        source: "manual",
        timestamp: now.toISOString(),
        repo: null,
        title: question,
        body: answer,
        refs: { issueKeys: [], prNumbers: [], branches: [], paths: [] },
        raw: { thread_id: thread.id, question, answer },
      });
      db.insertLink({
        event_id: eventId,
        thread_id: thread.id,
        confidence: 1.0,
        reason: "check-in answer",
      });
      saved++;
    }
  }

  if (aborted) {
    console.log(
      `\ncheck-in interrupted — ${saved} note(s) saved, window not advanced; run again to finish.`
    );
    return;
  }
  db.setState("last_checkin", now.toISOString());
  console.log(`\nSaved ${saved} note(s). They'll be included in future reports.`);
}
