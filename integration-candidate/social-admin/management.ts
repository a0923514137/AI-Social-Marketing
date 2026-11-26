import { socialDatabase } from "../shared/social.ts";
import { type Command, parseCommand } from "./commands.ts";

type Event = { action: string; value?: string; reply?: string };
type Item = {
  id: string;
  keyword: string;
  reply_text: string;
  global_enabled: boolean;
};
type Result = {
  kind: string;
  keyword?: string;
  reply?: string;
  nonce?: string;
  offset?: number;
  items?: Item[];
};
type Button = { text: string; callback_data: string };

const button = (text: string, action: string) => ({
  text,
  callback_data: "kw:" + action,
});
const menu = button("返回選單", "menu");

export function managementEvent(
  text: string | undefined,
  callback?: string,
): Event | null {
  if (callback !== undefined) {
    const match =
      /^kw:(menu|begin_add|on|off|cancel|list|choose_edit|choose_delete|pick_edit|pick_delete|confirm)(?::([0-9a-f-]+))?$/
        .exec(callback);
    if (!match) return null;
    const [, action, value] = match;
    if (["confirm", "pick_edit", "pick_delete"].includes(action)) {
      return value &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
        ? { action, value }
        : null;
    }
    if (
      value !== undefined &&
      (!["list", "choose_edit", "choose_delete"].includes(action) ||
        !/^\d{1,5}$/.test(value))
    ) return null;
    return { action, value };
  }
  if (!text || text.length > 4096) return null;
  const command: Command = parseCommand(text);
  if (command.action === "other") return { action: "text", value: text };
  return {
    action: command.action,
    value: "keyword" in command ? command.keyword : undefined,
    reply: "reply" in command ? command.reply : undefined,
  };
}

function render(result: Result): { text: string; buttons: Button[][] } | null {
  const { kind, keyword, reply, nonce } = result;
  if (kind === "other") return null;
  if (kind === "menu") {
    return {
      text: "三明治爸爸管理機器人\n請選擇關鍵字管理功能",
      buttons: [
        [
          button("新增關鍵字", "begin_add"),
          button("修改回覆內容", "choose_edit"),
        ],
        [
          button("刪除關鍵字", "choose_delete"),
          button("查看所有關鍵字", "list"),
        ],
        [button("啟用自動回覆", "on"), button("暫停自動回覆", "off")],
      ],
    };
  }
  if (kind === "list" || kind === "choose_edit" || kind === "choose_delete") {
    const items = result.items ?? [];
    const offset = result.offset ?? 0;
    const page = items.slice(0, 8);
    const scope = (item: Item) => item.global_enabled ? "" : "（指定貼文）";
    const rows = kind === "list" ? [] : page.map((item) => [
      button(
        Array.from(item.keyword).slice(0, 48).join("") + scope(item),
        (kind === "choose_edit" ? "pick_edit:" : "pick_delete:") + item.id,
      ),
    ]);
    const navigation = [];
    if (offset > 0) {
      navigation.push(button("上一頁", kind + ":" + Math.max(0, offset - 8)));
    }
    if (items.length > 8 && offset + 8 <= 99999) {
      navigation.push(button("下一頁", kind + ":" + (offset + 8)));
    }
    if (navigation.length) rows.push(navigation);
    rows.push([menu]);
    return {
      text: !page.length
        ? "尚無關鍵字"
        : kind === "list"
        ? page.map((item) =>
          item.keyword + scope(item) + "｜" + item.reply_text
        ).join("\n")
        : kind === "choose_edit"
        ? "請選擇要修改的關鍵字"
        : "請選擇要刪除的關鍵字",
      buttons: rows,
    };
  }
  if (
    nonce && ["confirm_add", "confirm_edit", "confirm_delete"].includes(kind)
  ) {
    return {
      text: kind === "confirm_delete"
        ? "確認刪除「" + keyword + "」及其指定貼文設定？"
        : "確認儲存「" + keyword + "」的回覆？\n" + reply,
      buttons: [[button("確認", "confirm:" + nonce), button("取消", "cancel")]],
    };
  }
  const messages: Record<string, string> = {
    keyword: "請輸入關鍵字",
    add_reply: "請輸入「" + keyword + "」的回覆文字",
    edit_reply: "請輸入「" + keyword + "」的新回覆文字",
    bad_keyword: "請輸入 1 至 100 字的關鍵字。",
    bad_reply: "請輸入 1 至 500 字的回覆文字。",
    await_confirm: "請使用確認或取消按鈕。",
    added: "已新增。IG、FB、Threads 共用此回覆。",
    edited: "已更新。三平台及符合條件的指定貼文共用新回覆。",
    deleted: "已刪除關鍵字及其指定貼文設定。",
    exists: "這個關鍵字已存在。請選擇修改回覆內容。",
    on: "已開啟三平台資料庫發送開關。實際發送仍受部署環境開關控制。",
    off: "已暫停三平台新回覆。",
    invalid:
      "指令格式有誤。可用選單，或輸入 /add 關鍵字 | 回覆、/edit 關鍵字 | 新回覆、/delete 關鍵字。",
    stale: "操作已過期或關鍵字已有變更，請返回選單重試。",
  };
  const pending = [
    "keyword",
    "add_reply",
    "edit_reply",
    "bad_keyword",
    "bad_reply",
  ].includes(kind);
  return {
    text: messages[kind] || messages.stale,
    buttons: [[pending ? button("取消", "cancel") : menu]],
  };
}

export async function management(event: Event, context: {
  base: string;
  service: string;
  actor: string;
  chat: string;
  update: number;
  bot: string;
  callback?: string;
}) {
  if (!context.bot) throw Error("bot_not_configured");
  async function telegram(method: string, body: unknown) {
    const response = await fetch(
      "https://api.telegram.org/bot" + context.bot + "/" + method,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok || (await response.json()).ok !== true) {
      throw Error("telegram_notification_failed");
    }
  }
  if (context.callback) {
    await telegram("answerCallbackQuery", {
      callback_query_id: context.callback,
    }).catch(() => {});
  }
  if (event.action === "invalid") {
    const message = render({ kind: "invalid" })!;
    await telegram("sendMessage", {
      chat_id: context.chat,
      text: message.text,
      reply_markup: { inline_keyboard: message.buttons },
    });
    return true;
  }
  const result = await socialDatabase(context.base, context.service).rpc<
    Result
  >("social_admin_event", {
    p_actor: context.actor,
    p_chat: context.chat,
    p_update: context.update,
    p_action: event.action,
    p_value: event.value ?? null,
    p_reply: event.reply ?? null,
  });
  const message = render(result);
  if (!message) return false;
  await telegram("sendMessage", {
    chat_id: context.chat,
    text: message.text,
    reply_markup: { inline_keyboard: message.buttons },
  });
  return true;
}
