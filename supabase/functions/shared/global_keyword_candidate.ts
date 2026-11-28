export type GlobalKeyword = {
  id: string;
  keyword: string;
  reply_text: string;
  global_enabled: boolean;
};

export const normalize = (text: string) =>
  text.normalize("NFKC").trim().toLowerCase();

export function bestKeywordMatch<T extends { keyword: string; id?: string }>(
  rules: T[],
  text: string,
  priority: (rule: T) => number = () => 0,
): T | undefined {
  const body = normalize(text);
  let best:
    | { rule: T; priority: number; length: number; index: number }
    | undefined;
  for (const rule of rules) {
    const keyword = normalize(rule.keyword);
    if (!keyword) continue;
    const index = body.indexOf(keyword);
    if (index < 0) continue;

    const scope = priority(rule);
    const order = best
      ? scope - best.priority || keyword.length - best.length ||
        best.index - index
      : 0;
    if (
      !best || order > 0 ||
      (order === 0 && (rule.id ?? "") < (best.rule.id ?? ""))
    ) {
      best = { rule, priority: scope, length: keyword.length, index };
    }
  }
  return best?.rule;
}

export function matchGlobalKeyword(
  rows: GlobalKeyword[],
  comment: string,
): GlobalKeyword | undefined {
  return bestKeywordMatch(
    rows.filter((rule) =>
      rule.global_enabled === true && typeof rule.keyword === "string" &&
      typeof rule.reply_text === "string" && rule.reply_text.trim().length > 0
    ),
    comment,
  );
}
