export type Command =
  | { action: "menu" | "list" | "on" | "off" }
  | { action: "add" | "edit"; keyword: string; reply: string }
  | { action: "delete"; keyword: string }
  | { action: "invalid" }
  | { action: "other" };

function validKeyword(value: string): boolean {
  const length = Array.from(value.normalize("NFKC").trim()).length;
  return length >= 1 && length <= 100;
}

export function parseCommand(input: string): Command {
  const text = input.trim();
  if (text === "選單" || text === "/menu") return { action: "menu" };
  const m = /^\/(add|edit|delete|list|on|off)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return { action: "other" };
  const action = m[1], arg = (m[2] || "").trim();
  if (action === "list" || action === "on" || action === "off") {
    return arg ? { action: "invalid" } : { action };
  }
  if (action === "delete") {
    return validKeyword(arg) ? { action, keyword: arg } : { action: "invalid" };
  }
  const i = arg.indexOf("|"),
    keyword = arg.slice(0, i).trim(),
    reply = arg.slice(i + 1).trim();
  if (
    i < 1 || !validKeyword(keyword) || !reply ||
    Array.from(reply).length > 500
  ) return { action: "invalid" };
  return { action: action as "add" | "edit", keyword, reply };
}
