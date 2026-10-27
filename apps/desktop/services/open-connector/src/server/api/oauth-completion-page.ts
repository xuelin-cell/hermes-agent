const oauthCompletionChannelName = "oomol-connect-oauth";
const oauthCompletedType = "oauth.completed";

// Client-side translations. English is also the server-rendered default in the
// markup below, so the page stays meaningful without JavaScript. The copy stays
// host-neutral because this runtime can be embedded by more than one product.
const oauthCompletionStrings = {
  en: {
    badge: "Connected",
    title: "Connection complete",
    body: "Close this tab to continue where you started.",
    closeInstruction: "You can now close this tab.",
  },
  "zh-CN": {
    badge: "已连接",
    title: "连接完成",
    body: "请关闭此标签页，然后回到刚才的应用继续。",
    closeInstruction: "现在可以手动关闭此标签页。",
  },
  "zh-TW": {
    badge: "已連線",
    title: "連線完成",
    body: "請關閉此分頁，然後回到剛才的應用繼續。",
    closeInstruction: "現在可以手動關閉此分頁。",
  },
  ja: {
    badge: "接続済み",
    title: "接続が完了しました",
    body: "このタブを閉じて、元のアプリに戻って続行してください。",
    closeInstruction: "このタブを閉じても問題ありません。",
  },
};

export function renderOAuthCompletionPage(service: string): string {
  const payload = scriptJson({
    type: oauthCompletedType,
    service,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connection complete</title>
<style>
:root {
  --background: hsl(0 0% 100%);
  --foreground: hsl(222.2 84% 4.9%);
  --card: hsl(0 0% 100%);
  --card-foreground: hsl(222.2 84% 4.9%);
  --muted: hsl(210 40% 96.1%);
  --muted-foreground: hsl(215.4 16.3% 46.9%);
  --border: hsl(214.3 31.8% 91.4%);
  --primary: hsl(222.2 47.4% 11.2%);
  --primary-foreground: hsl(210 40% 98%);
  --ring: hsl(222.2 84% 4.9%);
}
* {
  box-sizing: border-box;
}
body {
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--background);
  color: var(--foreground);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.card {
  width: min(100%, 420px);
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card);
  color: var(--card-foreground);
  box-shadow: 0 1px 2px hsl(222.2 84% 4.9% / 0.04), 0 12px 32px hsl(222.2 84% 4.9% / 0.08);
}
.header {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.badge {
  width: fit-content;
  display: inline-flex;
  align-items: center;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 2px 10px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
}
h1 {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
}
p {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 14px;
  line-height: 22px;
}
code {
  border-radius: 6px;
  background: var(--muted);
  padding: 2px 6px;
  color: var(--foreground);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
}
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 24px;
}
.close-note {
  font-size: 12px;
  line-height: 18px;
}
</style>
</head>
<body>
<main class="card" role="status" aria-live="polite">
  <div class="header">
    <span class="badge" data-t="badge">Connected</span>
    <h1 data-t="title">Connection complete</h1>
    <p data-t="body">Close this window to continue where you started.</p>
  </div>
  <div class="actions">
    <p class="close-note" data-t="closeInstruction">You can now close this tab.</p>
  </div>
</main>
<script>(()=>{
const STR=${scriptJson(oauthCompletionStrings)};
if("BroadcastChannel" in window){const channel=new BroadcastChannel(${scriptJson(oauthCompletionChannelName)});channel.postMessage(${payload});channel.close();}
const pick=()=>{const langs=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||"en"];for(const raw of langs){const l=String(raw).toLowerCase();if(l.startsWith("zh"))return (!l.includes("hans")&&(l.includes("tw")||l.includes("hk")||l.includes("mo")||l.includes("hant")))?"zh-TW":"zh-CN";const primary=l.split("-")[0];if(STR[raw])return raw;if(STR[primary])return primary;}return "en";};
const t=STR[pick()]||STR.en;
document.documentElement.lang=pick();
for(const el of document.querySelectorAll("[data-t]")){const key=el.getAttribute("data-t");if(t[key]!=null)el.textContent=t[key];}
if(t.title)document.title=t.title;
})();</script>
</body>
</html>`;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
