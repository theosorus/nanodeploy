export function sameRequestOrigin(origin: string | undefined, site: string | undefined, expected: string) {
  if (site && site !== "same-origin" && site !== "none") return false;
  return origin ? origin === new URL(expected).origin : site === "same-origin";
}

export const safeRedirectPath = (path: string | undefined) =>
  path && /^\/(?![\/\\])/.test(path) && !/[\\\u0000-\u0020\u007f]/.test(path) ? path : "/";

export const RECENT_AUTH = 15 * 60_000;
export function recentlyAuthenticated(at: Date) {
  const age = Date.now() - new Date(at).getTime();
  return age >= 0 && age < RECENT_AUTH;
}
