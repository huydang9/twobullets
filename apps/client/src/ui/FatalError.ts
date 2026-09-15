import { t } from "../i18n";

// A start or frame failure used to leave a frozen frame (Babylon stops its render loop when a frame throws) or the map
// loading card on screen. This covers everything with the error and a way out. Plain DOM and inline styles: it must work
// even when the HUD never got built.

const ROOT_STYLE =
  "position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(6,8,10,.82);" +
  "font:14px/1.5 system-ui,sans-serif;color:#eee";
const PANEL_STYLE = "max-width:620px;padding:22px 26px;background:#15181c;border:1px solid #333;border-radius:6px";
const DETAIL_STYLE = "margin:10px 0 16px;max-height:220px;overflow:auto;white-space:pre-wrap;font:12px/1.4 ui-monospace,monospace;color:#bbb";
const BUTTON_STYLE = "margin-right:10px;padding:7px 16px;border:0;border-radius:3px;background:#e8b04a;color:#111;font-weight:600;cursor:pointer";

let shown = false;

/** Shows the failure once (later ones only log). `where` names the step ("start", "frame"). */
export function showFatalError(error: unknown, where: string): void {
  console.error(`[twobullets] ${where} failed`, error);
  if (shown || typeof document === "undefined") return;
  shown = true;
  if (document.pointerLockElement) document.exitPointerLock();
  const root = document.createElement("div");
  root.style.cssText = ROOT_STYLE;
  const panel = document.createElement("div");
  panel.style.cssText = PANEL_STYLE;
  const title = document.createElement("div");
  title.style.cssText = "font-size:18px;font-weight:700;color:#ff6a55";
  title.textContent = t(where === "frame" ? "fatal.frame" : "fatal.start");
  const detail = document.createElement("pre");
  detail.style.cssText = DETAIL_STYLE;
  detail.textContent = error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.style.cssText = BUTTON_STYLE;
  reload.textContent = t("fatal.reload");
  reload.addEventListener("click", () => window.location.reload());
  const menu = document.createElement("button");
  menu.type = "button";
  menu.style.cssText = `${BUTTON_STYLE};background:#444;color:#eee`;
  menu.textContent = t("fatal.menu");
  menu.addEventListener("click", () => {
    const lang = new URLSearchParams(window.location.search).get("lang");
    window.location.assign(`${window.location.pathname}${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`);
  });
  panel.append(title, detail, reload, menu);
  root.append(panel);
  document.body.append(root);
}
