export function sameRequestOrigin(origin: string | undefined, site: string | undefined, expected: string) {
  if (site && site !== "same-origin" && site !== "none") return false;
  return origin ? origin === new URL(expected).origin : site === "same-origin";
}

// A WebSocket handshake is a GET that carries the session cookie and that no
// CORS check ever guards: without this, a page of a sibling app could open a
// socket to another app as its visitor and read everything sent over it. A
// browser always sends both headers on a handshake, and no script can forge or
// drop them.
export const isWebSocketHandshake = (upgrade: string | undefined, key: string | undefined) =>
  Boolean(key) || /(?:^|,)\s*websocket\s*(?:,|$)/i.test(upgrade ?? "");

// Following a link is not a decision to sign out: a request a browser marks as
// coming from another origin (a sibling app, any other site) is not obeyed.
// Browsers that do not send Fetch Metadata are let through.
export const initiatedByOwnPage = (site: string | undefined) =>
  !site || site === "same-origin" || site === "none";

// The proof that links a sign-in to the browser that asked for it: the hash of
// a random cookie only that browser holds on the app's host.
export const SIGN_IN_STATE_RE = /^[A-Za-z0-9_-]{43}$/;
export const signInState = (value: unknown): string | null =>
  typeof value === "string" && SIGN_IN_STATE_RE.test(value) ? value : null;

export const safeRedirectPath = (path: string | undefined) =>
  path && /^\/(?![\/\\])/.test(path) && !/[\\\u0000-\u0020\u007f]/.test(path) ? path : "/";

export const RECENT_AUTH = 15 * 60_000;
export function recentlyAuthenticated(at: Date) {
  const age = Date.now() - new Date(at).getTime();
  return age >= 0 && age < RECENT_AUTH;
}
