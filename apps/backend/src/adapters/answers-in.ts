export const ANSWERS_IN_MAX = 200;
export const ANSWER_TEXT_MAX = 2048;

export type AnswerIn = { at: number; conn: number; text: string; cut: boolean };
export type AnswersIn = AnswerIn[];

export function emptyAnswersIn(): AnswersIn {
  return [];
}

function textOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "unserializable";
  }
}

/** Appends one received answer-channel value; evicts the oldest past ANSWERS_IN_MAX. Never throws. */
export function noteAnswerIn(
  log: AnswersIn,
  entry: { at: number; conn: number; value: unknown },
): void {
  const text = textOf(entry.value);
  const cut = text.length > ANSWER_TEXT_MAX;
  log.push({
    at: entry.at,
    conn: entry.conn,
    text: cut ? text.slice(0, ANSWER_TEXT_MAX) : text,
    cut,
  });
  if (log.length > ANSWERS_IN_MAX) log.splice(0, log.length - ANSWERS_IN_MAX);
}
