import { matchRule } from "./social.ts";
import { matchGlobalKeyword } from "./global_keyword_candidate.ts";
const row = (keyword: string, global_enabled = true, reply_text = "reply") => ({
  id: keyword,
  keyword,
  global_enabled,
  reply_text,
});
Deno.test("matches normalized AI", () => {
  if (matchGlobalKeyword([row("AI")], "ＡＩ")?.keyword !== "AI") {
    throw Error("match");
  }
});
Deno.test("longest match wins", () => {
  if (
    matchGlobalKeyword([row("AI"), row("AI系統")], "AI系統")?.keyword !==
      "AI系統"
  ) throw Error("priority");
});
Deno.test("disabled and empty rules ignored", () => {
  if (
    matchGlobalKeyword([row("AI", false), row(""), row("AI", true, " ")], "AI")
  ) throw Error("invalid match");
});
Deno.test("no implicit alias", () => {
  if (matchGlobalKeyword([row("AI")], "系統")) throw Error("alias");
});

Deno.test("equal-length matches use first occurrence regardless of rule order", () => {
  const rows = [row("人工智慧"), row("影片剪輯")];
  for (const order of [rows, [...rows].reverse()]) {
    if (
      matchGlobalKeyword(order, "影片剪輯與人工智慧")?.keyword !== "影片剪輯" ||
      matchGlobalKeyword(order, "人工智慧和影片剪輯")?.keyword !== "人工智慧"
    ) {
      throw new Error("expected the keyword appearing first");
    }
  }
});

Deno.test("identical normalized matches use a deterministic id tie-break", () => {
  const rows = [{ ...row("ＡＩ"), id: "z" }, { ...row("AI"), id: "a" }];
  for (const order of [rows, [...rows].reverse()]) {
    if (matchGlobalKeyword(order, "ＡＩ")?.id !== "a") {
      throw new Error("id priority");
    }
  }
});

Deno.test("shared platform rules prioritize a scoped match before comparing first occurrence", () => {
  const ai = {
    keyword: "人工智慧",
    reply_text: "AI",
    global: true,
    post_ids: [],
  };
  const editing = {
    keyword: "影片剪輯",
    reply_text: "Editing",
    global: true,
    post_ids: [],
  };
  const text = "影片剪輯與人工智慧";
  for (const order of [[ai, editing], [editing, ai]]) {
    if (matchRule(order, "video", text) !== editing) {
      throw new Error("expected the first equal-length global match");
    }
  }
  const scoped = {
    keyword: "智慧",
    reply_text: "Scoped",
    global: false,
    post_ids: ["video"],
  };
  if (
    matchRule([ai, editing, scoped], "video", text) !== scoped ||
    matchRule([ai, editing, scoped], "other", text) !== editing
  ) {
    throw new Error(
      "expected post scope to outrank length only on its own post",
    );
  }
});
