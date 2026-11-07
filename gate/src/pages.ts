import type { Lang, T } from "./i18n.js";
import { ago } from "./i18n.js";
import type { AccessKey, Passkey, User } from "./db.js";
import { AUTH_ORIGIN } from "./config.js";

// absolute: the "not allowed" page is answered on an app's own host, where
// /static belongs to the app

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);

// Shared palette and controls with the console; all assets are served locally.
const CSS = `
  :root {
    --paper: #f7f8fa; --surface: #fff; --ink: #142942; --soft: #5e6d82; --rule: #e5e9ef;
    --live: #19724e; --live-fill: #36a477; --danger: #bc4149; --radius: 9px;
    --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
    --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 14px/1.6 var(--ui); }
  .wrap { max-width: 490px; margin: 0 auto; padding: 65px 20px 45px; }
  .wrap.wide { max-width: 940px; padding-top: 40px; }
  header { margin-bottom: 31px; display: flex; justify-content: center; align-items: center; }
  header img { display: block; height: auto; width: 174px; }
  .wide header { justify-content: flex-start; margin-left: 3px; }
  .auth-card { border: 1px solid var(--rule); background: #fff; border-radius: 15px; padding: 35px; box-shadow: 0 5px 24px #14294204; }
  .wide .auth-card { padding: 36px; }
  h1 { font-size: 26px; line-height: 1.25; font-weight: 650; margin: 0 0 11px; letter-spacing: -.035em; }
  h2 { font-size: 16px; color: var(--ink); font-weight: 600; margin: 30px 0 14px; padding-top: 25px; border-top: 1px solid var(--rule); letter-spacing: -.015em; }
  p { margin: 0 0 18px; }
  .soft { color: var(--soft); font-size: 13px; }
  .num { font-family: var(--mono); font-size: 12px; }
  label { display: block; font-size: 12px; font-weight: 550; margin: 18px 0 7px; }
  input, select { width: 100%; font: inherit; font-size: 14px; color: var(--ink); background: #fff; border: 1px solid #d8e0eb; border-radius: 8px; padding: 11px 13px; min-height: 46px; }
  input:hover, select:hover { border-color: #b9c6d8; }
  input:focus { border-color: #91abe0; }
  :focus-visible { outline: 3px solid #7699ed; outline-offset: 3px; }
  button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 9px; font: inherit; font-size: 13px; font-weight: 550; min-height: 43px; padding: 10px 16px; cursor: pointer; border-radius: 8px; border: 1px solid #d8e0eb; background: #fff; color: var(--ink); text-decoration: none; }
  button:hover, .btn:hover { border-color: #aebed2; background: #fafbfd; }
  button:disabled { cursor: wait; opacity: .55; }
  .primary { background: var(--ink); border-color: var(--ink); color: #fff; width: 100%; margin-top: 25px; min-height: 45px; }
  .primary:hover { background: #233e60; border-color: #233e60; }
  .wide-btn { width: 100%; margin-top: 10px; min-height: 45px; }
  .wide-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.65; stroke-linecap: round; stroke-linejoin: round; }
  .passkey-hint { text-align: center; margin: 9px 0 0; font-size: 11px; color: var(--soft); }
  .danger { color: var(--danger); }
  .danger:hover { border-color: #e3b5ba; background: #fff6f6; }
  .or { display: flex; align-items: center; gap: 13px; color: var(--soft); font-size: 11px; margin: 24px 0 22px; }
  .or::before, .or::after { content: ""; flex: 1; border-top: 1px solid var(--rule); }
  .error { border: 1px solid #edc8cb; background: #fff5f5; border-radius: 8px; padding: 11px 13px; color: #a3303b; margin: 18px 0; font-size: 13px; }
  .ok { border: 1px solid #c3dfcf; background: #f1f8f4; color: var(--live); border-radius: 8px; padding: 11px 13px; margin: 18px 0; font-size: 13px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 14px; border-top: 1px solid var(--rule); padding: 15px 0; }
  .row:last-of-type { border-bottom: 1px solid var(--rule); }
  .row > span { min-width: 0; overflow-wrap: anywhere; }
  .row .soft { font-size: 12px; }
  .row form { margin: 0; flex: none; }
  .row button { min-height: 35px; padding: 6px 11px; font-size: 11px; }
  .badge { display: inline-block; font-size: 10px; font-weight: 550; color: #466ba6; background: #edf2fb; border: 1px solid #dce6f5; border-radius: 5px; padding: 1px 7px; }
  .keybox { background: #f1f6ff; border: 1px solid #cfdef5; border-radius: 9px; padding: 17px; margin: 14px 0; }
  .keybox code { display: block; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; user-select: all; margin-top: 9px; }
  .inline { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .inline > div { flex: 1; min-width: 160px; }
  .inline label { margin-top: 12px; }
  a { color: #4167c1; text-underline-offset: 3px; }
  .row a { color: var(--ink); font-weight: 550; text-decoration: none; }
  .row a:hover { color: #4167c1; }
  [hidden] { display: none !important; }
  @media (max-width: 600px) {
    .wrap, .wrap.wide { padding: 34px 18px; }
    .auth-card, .wide .auth-card { padding: 27px 23px; border-radius: 13px; }
    .wide header { justify-content: center; }
    h1 { font-size: 24px; }
    .inline { flex-direction: column; align-items: stretch; }
    .inline > div { min-width: 0; width: 100%; }
    .row { flex-wrap: wrap; }
    .row > span { flex: 1 1 200px; }
    input, select { font-size: 16px; }
  }
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
<div class="wrap${opts.wide ? " wide" : ""}">
<header><img src="${AUTH_ORIGIN}/static/wordmark.svg" alt="Nanodeploy" width="174" height="37"></header>
<main class="auth-card">${body}</main>
</div>
${opts.script ? `<script src="${AUTH_ORIGIN}/static/gate.js" defer></script>` : ""}
</body>
</html>`;
}

export function loginPage(t: T, lang: Lang, o: { to: string; appName?: string | null; consoleConfirm?: boolean; error?: string | null; login?: string }) {
  const sub = o.consoleConfirm
    ? `<p class="soft">${esc(t("signInConsole"))}</p>`
    : o.appName
      ? `<p class="soft">${esc(t("signInTo", { app: o.appName }))}</p>`
      : `<p class="soft">${esc(t("signInWelcome"))}</p>`;
  return layout(lang, t("signIn"), `
    <h1>${esc(t("signIn"))}</h1>
    ${sub}
    ${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ""}
    <button type="button" class="wide-btn" data-passkey-login data-to="${esc(o.to)}" aria-describedby="passkey-hint"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-4-4 3-3m-6 0 3-3"/></svg>${esc(t("usePasskey"))}</button>
    <p class="passkey-hint" id="passkey-hint">${esc(t("passkeyHint"))}</p>
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
