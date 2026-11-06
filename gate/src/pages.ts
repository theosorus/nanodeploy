import type { Lang, T } from "./i18n.js";
import { ago } from "./i18n.js";
import type { AccessKey, Passkey, User } from "./db.js";
import { AUTH_ORIGIN } from "./config.js";

// absolute: the "not allowed" page is answered on an app's own host, where
// /static belongs to the app

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);

// Same ground as the dashboard: cream paper, dark-blue ink, ochre for the one
// thing that matters on the page. No webfont, no script from anywhere else.
const CSS = `
  :root {
    --paper: #f4ecd8; --surface: #fbf4e4; --ink: #03224c; --soft: #6f6a58; --rule: #ddd0af;
    --live: #7a5610; --live-fill: #c9a227; --danger: #8c2f24; --radius: 2px;
    --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
    --ui: system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 var(--ui); }
  .wrap { max-width: 440px; margin: 0 auto; padding: var(--s7) var(--s4); }
  .wrap.wide { max-width: 620px; }
  header { margin-bottom: var(--s6); display: flex; justify-content: space-between; align-items: center; gap: var(--s3); }
  header img { display: block; height: 22px; width: auto; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 var(--s2); letter-spacing: -0.01em; }
  h2 { font-family: var(--mono); font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase;
       color: var(--soft); font-weight: 500; margin: var(--s6) 0 var(--s3); }
  p { margin: 0 0 var(--s4); }
  .soft { color: var(--soft); font-size: 14px; }
  .num { font-family: var(--mono); font-size: 13px; }
  label { display: block; font-size: 13px; color: var(--soft); margin: var(--s4) 0 6px; }
  input, select {
    width: 100%; font: inherit; color: var(--ink); background: var(--surface);
    border: 1px solid var(--rule); border-radius: var(--radius); padding: 10px 12px; min-height: 44px;
  }
  input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible {
    outline: 2px solid var(--live); outline-offset: 2px;
  }
  button, .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    font: inherit; font-size: 15px; min-height: 44px; padding: 10px 18px; cursor: pointer;
    border-radius: var(--radius); border: 1px solid var(--rule); background: none; color: var(--ink);
    text-decoration: none;
  }
  button:hover, .btn:hover { border-color: var(--live); }
  .primary { background: var(--ink); border-color: var(--ink); color: var(--surface); width: 100%; margin-top: var(--s5); }
  .primary:hover { background: #0b3266; }
  .wide-btn { width: 100%; }
  .danger:hover { border-color: var(--danger); color: var(--danger); }
  .or { display: flex; align-items: center; gap: var(--s3); color: var(--soft); font-size: 13px; margin: var(--s5) 0; }
  .or::before, .or::after { content: ""; flex: 1; border-top: 1px solid var(--rule); }
  .error { border-left: 3px solid var(--danger); padding: 6px 12px; color: var(--danger); margin: var(--s4) 0; font-size: 14px; }
  .ok { border-left: 3px solid var(--live-fill); padding: 6px 12px; margin: var(--s4) 0; font-size: 14px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: var(--s3);
         border-top: 1px solid var(--rule); padding: var(--s3) 0; }
  .row:last-of-type { border-bottom: 1px solid var(--rule); }
  .row form { margin: 0; }
  .badge { font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
           color: var(--live); border: 1px solid var(--live-fill); border-radius: 99px; padding: 1px 8px; }
  .keybox { border: 1px solid var(--live); border-radius: var(--radius); padding: var(--s3); margin: var(--s3) 0; }
  .keybox code { display: block; font-family: var(--mono); font-size: 13px; word-break: break-all; user-select: all; margin-top: 6px; }
  .inline { display: flex; gap: var(--s2); align-items: flex-end; flex-wrap: wrap; }
  .inline > div { flex: 1; min-width: 160px; }
  .inline label { margin-top: var(--s3); }
  a { color: var(--ink); }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

export function layout(lang: Lang, title: string, body: string, opts: { wide?: boolean; script?: boolean } = {}) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="referrer" content="same-origin">
<title>${esc(title)} · Nanodeploy</title>
<link rel="icon" href="${AUTH_ORIGIN}/static/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body>
<main class="wrap${opts.wide ? " wide" : ""}">
<header><img src="${AUTH_ORIGIN}/static/wordmark.svg" alt="Nanodeploy"></header>
${body}
</main>
${opts.script ? `<script src="${AUTH_ORIGIN}/static/gate.js" defer></script>` : ""}
</body>
</html>`;
}

export function loginPage(t: T, lang: Lang, o: { to: string; appName?: string | null; consoleConfirm?: boolean; error?: string | null; login?: string }) {
  const sub = o.consoleConfirm
    ? `<p class="soft">${esc(t("signInConsole"))}</p>`
    : o.appName
      ? `<p class="soft">${esc(t("signInTo", { app: o.appName }))}</p>`
      : "";
  return layout(lang, t("signIn"), `
    <h1>${esc(t("signIn"))}</h1>
    ${sub}
    ${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ""}
    <button type="button" class="wide-btn" data-passkey-login data-to="${esc(o.to)}">${esc(t("usePasskey"))}</button>
    <p class="error" id="wa-error" role="alert" hidden data-failed="${esc(t("passkeyFailed"))}" data-unsupported="${esc(t("noPasskeySupport"))}"></p>
    <div class="or">${esc(t("or"))}</div>
    <form method="post" action="/login">
      <input type="hidden" name="to" value="${esc(o.to)}">
      <label for="login">${esc(t("login"))}</label>
      <input id="login" name="login" autocomplete="username webauthn" autocapitalize="none" spellcheck="false" required value="${esc(o.login ?? "")}">
      <label for="password">${esc(t("password"))}</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button class="primary" type="submit">${esc(t("submitSignIn"))}</button>
    </form>`, { script: true });
}

export function tokenPage(
  t: T,
  lang: Lang,
  o: { token: string; purpose: "welcome" | "reset" | "setup"; name: string; error?: string | null; values?: Record<string, string> },
) {
  const v = o.values ?? {};
  const title =
    o.purpose === "setup" ? t("setupTitle") : o.purpose === "reset" ? t("resetTitle", { name: o.name }) : t("welcomeTitle", { name: o.name });
  const intro = o.purpose === "setup" ? t("setupBody") : o.purpose === "reset" ? t("resetBody") : t("welcomeBody");
  const setupFields =
    o.purpose === "setup"
      ? `<label for="username">${esc(t("username"))}</label>
         <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${esc(v.username)}">
         <label for="display_name">${esc(t("displayName"))}</label>
         <input id="display_name" name="display_name" autocomplete="name" required value="${esc(v.display_name)}">
         <label for="email">${esc(t("emailOptional"))}</label>
         <input id="email" name="email" type="email" autocomplete="email" value="${esc(v.email)}">`
      : "";
  const passkeyOption =
    o.purpose === "setup"
      ? ""
      : `<div class="or">${esc(t("or"))}</div>
         <button type="button" class="wide-btn" data-passkey-register data-token="${esc(o.token)}">${esc(t("createPasskeyInstead"))}</button>
         <p class="error" id="wa-error" role="alert" hidden data-failed="${esc(t("passkeyFailed"))}" data-unsupported="${esc(t("noPasskeySupport"))}"></p>`;
  return layout(lang, title, `
    <h1>${esc(title)}</h1>
    <p class="soft">${esc(intro)}</p>
    ${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ""}
    <form method="post" action="/welcome/${esc(o.token)}">
      ${setupFields}
      <label for="password">${esc(t("newPassword"))}</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required>
      <label for="confirm">${esc(t("confirmPassword"))}</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required>
      <button class="primary" type="submit">${esc(t("saveContinue"))}</button>
    </form>
    ${passkeyOption}`, { script: o.purpose !== "setup" });
}

export function messagePage(t: T, lang: Lang, title: string, body: string, links: string = "") {
  return layout(lang, title, `<h1>${esc(title)}</h1><p class="soft">${esc(body)}</p>${links}`);
}

export type AccountView = {
  user: User;
  apps: { name: string; url: string; roles: string[] }[];
  hasPassword: boolean;
  passkeys: Passkey[];
  keys: AccessKey[];
  keyApps: { slug: string; name: string }[];
  newKey?: string | null;
  notice?: string | null;
  error?: string | null;
};

export function accountPage(t: T, lang: Lang, v: AccountView) {
  const apps = v.apps.length
    ? v.apps
        .map(
          (a) => `<div class="row"><span><a href="${esc(a.url)}">${esc(a.name)}</a>
            ${a.roles.length ? `<span class="soft"> · ${esc(t("rolesIn", { roles: a.roles.join(", ") }))}</span>` : ""}</span>
            <span class="num soft">${esc(new URL(a.url).host)}</span></div>`,
        )
        .join("")
    : `<p class="soft">${esc(t("noApps"))}</p>`;

  const passwordForm = `
    <form method="post" action="/account/password">
      ${v.hasPassword ? `<label for="current">${esc(t("currentPassword"))}</label>
      <input id="current" name="current" type="password" autocomplete="current-password" required>` : `<p class="soft">${esc(t("noPassword"))}</p>`}
      <label for="password">${esc(t("newPassword"))}</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required>
      <label for="confirm">${esc(t("confirmPassword"))}</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required>
      <button type="submit" style="margin-top:16px">${esc(v.hasPassword ? t("changePassword") : t("setPassword"))}</button>
    </form>`;

  const passkeys =
    (v.passkeys.length
      ? v.passkeys
          .map(
            (p) => `<div class="row"><span>${esc(p.label || "passkey")}
              <span class="soft"> · ${esc(p.last_used_at ? t("lastUsed", { when: ago(lang, p.last_used_at) }) : t("neverUsed"))}</span></span>
              <form method="post" action="/account/passkeys/${esc(p.id)}/delete"><button class="danger" type="submit">${esc(t("remove"))}</button></form></div>`,
          )
          .join("")
      : `<p class="soft">${esc(t("noPasskeys"))}</p>`) +
    `<div class="inline" style="margin-top:8px">
       <div><label for="passkey-label">${esc(t("passkeyLabel"))}</label><input id="passkey-label" maxlength="60"></div>
       <button type="button" data-passkey-register>${esc(t("addPasskey"))}</button>
     </div>
     <p class="error" id="wa-error" role="alert" hidden data-failed="${esc(t("passkeyFailed"))}" data-unsupported="${esc(t("noPasskeySupport"))}"></p>`;

  const keyList = v.keys.length
    ? v.keys
        .map(
          (k) => `<div class="row"><span><span class="num">${esc(k.hint)}</span> · ${esc(k.label)}
            <span class="soft"> · ${esc(k.apps ? k.apps.join(", ") : t("allMyApps"))} · ${esc(t("keyExpires", { when: ago(lang, k.expires_at) }))}</span></span>
            <form method="post" action="/account/keys/${esc(k.id)}/delete"><button class="danger" type="submit">${esc(t("remove"))}</button></form></div>`,
        )
        .join("")
    : `<p class="soft">${esc(t("noKeys"))}</p>`;

  const newKey = v.newKey
    ? `<div class="keybox"><span class="soft">${esc(t("keyShownOnce"))}</span><code>${esc(v.newKey)}</code>
       <code>Authorization: Bearer ${esc(v.newKey)}</code></div>`
    : "";

  return layout(lang, t("accountTitle"), `
    <h1>${esc(t("accountTitle"))}</h1>
    <p class="soft">${esc(t("signedInAs", { name: v.user.display_name }))} <span class="num">(${esc(v.user.username)})</span>
      ${v.user.role === "admin" ? `<span class="badge">${esc(t("adminBadge"))}</span>` : ""}</p>
    ${v.notice ? `<p class="ok" role="status">${esc(v.notice)}</p>` : ""}
    ${v.error ? `<p class="error" role="alert">${esc(v.error)}</p>` : ""}

    <h2>${esc(t("yourApps"))}</h2>
    ${apps}

    <h2>${esc(t("passkeysTitle"))}</h2>
    <p class="soft">${esc(t("passkeysNote"))}</p>
    ${passkeys}

    <h2>${esc(t("passwordTitle"))}</h2>
    ${passwordForm}

    <h2>${esc(t("keysTitle"))}</h2>
    <p class="soft">${esc(t("keysNote"))}</p>
    ${newKey}
    ${keyList}
    <form method="post" action="/account/keys" class="inline" style="margin-top:8px">
      <div><label for="key-label">${esc(t("keyLabel"))}</label><input id="key-label" name="label" maxlength="60" required></div>
      <div><label for="key-app">${esc(t("keyApps"))}</label>
        <select id="key-app" name="app"><option value="">${esc(t("allMyApps"))}</option>
          ${v.keyApps.map((a) => `<option value="${esc(a.slug)}">${esc(a.name)}</option>`).join("")}
        </select></div>
      <button type="submit">${esc(t("createKey"))}</button>
    </form>

    <p class="soft" style="margin-top:48px">${esc(t("privacyNote"))}</p>
    <form method="post" action="/logout"><button type="submit">${esc(t("signOut"))}</button></form>`,
    { wide: true, script: true });
}

export function forbiddenPage(t: T, lang: Lang, name: string, reason: string, authOrigin: string) {
  return messagePage(
    t,
    lang,
    t("forbiddenTitle"),
    t("forbiddenBody", { name, reason }),
    `<p><a class="btn" href="${esc(authOrigin)}/account">${esc(t("backToAccount"))}</a>
       <a class="btn" href="/_nd/logout">${esc(t("otherAccount"))}</a></p>`,
  );
}
