// Pure candidate for shared global keyword matching. No network or send side effects.
export type GlobalKeyword = { id: string; keyword: string; reply_text: string; global_enabled: boolean };
export function matchGlobalKeyword(rows: GlobalKeyword[], comment: string): GlobalKeyword | undefined {
  const normalize = (s: string) => s.normalize("NFKC").trim().toLowerCase();
  const body = normalize(comment);
  return rows.filter(r => r.global_enabled === true && typeof r.keyword === "string" &&
    typeof r.reply_text === "string" && normalize(r.keyword).length > 0 &&
    r.reply_text.trim().length > 0 && body.includes(normalize(r.keyword)))
    .sort((a,b) => normalize(b.keyword).length - normalize(a.keyword).length ||
      normalize(a.keyword).localeCompare(normalize(b.keyword)) || a.id.localeCompare(b.id))[0];
}
