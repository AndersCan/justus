import { describe, expect, it } from "vite-plus/test";
import { ANSWERS_IN_MAX, ANSWER_TEXT_MAX, emptyAnswersIn, noteAnswerIn } from "./answers-in.ts";

describe("noteAnswerIn", () => {
  it("keeps the newest entries, cuts long text and survives a circular value", () => {
    const log = emptyAnswersIn();
    for (let i = 0; i < 205; i++) noteAnswerIn(log, { at: i, conn: 1, value: { i } });
    expect(log).toHaveLength(ANSWERS_IN_MAX);
    expect(log[0]!.at).toBe(5);
    expect(log.at(-1)!.at).toBe(204);
    expect(log[0]).toMatchObject({ text: '{"i":5}', cut: false });

    noteAnswerIn(log, { at: 300, conn: 2, value: "x".repeat(5000) });
    const long = log.at(-1)!;
    expect(long.text).toHaveLength(ANSWER_TEXT_MAX);
    expect(long.cut).toBe(true);

    // JSON of a 2046-char string is exactly ANSWER_TEXT_MAX chars: kept whole.
    noteAnswerIn(log, { at: 299, conn: 2, value: "y".repeat(ANSWER_TEXT_MAX - 2) });
    expect(log.at(-1)).toMatchObject({ cut: false });
    expect(log.at(-1)!.text).toHaveLength(ANSWER_TEXT_MAX);

    const loop: Record<string, unknown> = {};
    loop.self = loop;
    noteAnswerIn(log, { at: 301, conn: 2, value: loop });
    expect(log.at(-1)!.text).toBe("unserializable");

    noteAnswerIn(log, { at: 302, conn: 2, value: undefined });
    expect(log.at(-1)!.text).toBe("undefined");
  });
});
