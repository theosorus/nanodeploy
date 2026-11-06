import type { AppPolicy, Group, User } from "./db.js";

export type Identity = {
  user: User;
  groups: Group[];
  via: "session" | "key";
  // set for a personal access key limited to some apps
  keyApps?: string[] | null;
};

export type Decision =
  | { ok: true; roles: string[] }
  | { ok: false; status: 401 | 403; reason: string; roles: string[] };

// Paths are compared the way caddy's path matcher compares them, and then some:
// case-insensitive, percent-decoded (except an encoded slash), dot segments
// resolved. Every one of those can only make a path look *more* protected, never
// less: "/API/Admin/../admin/x" is matched as "/api/admin/x".
export function normalizePath(uri: string): string {
  const raw = uri.split("?")[0] || "/";
  let decoded = raw;
  try {
    decoded = decodeURI(raw);
  } catch {
    // malformed escapes: match on the raw form
  }
  let path = decoded;
  try {
    path = new URL(decoded, "http://x").pathname;
  } catch {
    // keep the decoded form
  }
  return path.toLowerCase();
}

export function matchPath(pattern: string, path: string): boolean {
  const p = pattern.toLowerCase();
  return p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : path === p;
}

export function protectRule(app: AppPolicy, uri: string) {
  const path = normalizePath(uri);
  return app.protect.find((r) => matchPath(r.path, path)) ?? null;
}

// Administrators hold every role an app declares: the owner should not have to
// grant themselves "moderator" on each of their own apps.
export function effectiveRoles(app: AppPolicy, id: Identity | null, granted: string[]): string[] {
  if (!id) return [];
  if (id.user.role === "admin") return [...app.roles];
  return app.roles.filter((r) => granted.includes(r));
}

export function decide(app: AppPolicy, id: Identity | null, granted: string[], uri: string): Decision {
  const roles = effectiveRoles(app, id, granted);
  const rule = protectRule(app, uri);
  const needUser = app.access !== "public" || rule !== null;

  if (!id) {
    return needUser ? { ok: false, status: 401, reason: "sign in first", roles } : { ok: true, roles };
  }
  if (id.via === "key" && id.keyApps && !id.keyApps.includes(app.slug)) {
    return { ok: false, status: 403, reason: "this access key is not valid for this app", roles: [] };
  }
  if (app.access === "groups" && id.user.role !== "admin") {
    const names = id.groups.map((g) => g.name);
    // holding any role of the app also lets you in: a moderator of a members
    // only app does not need to be in its group as well
    if (!app.groups.some((g) => names.includes(g)) && roles.length === 0) {
      return { ok: false, status: 403, reason: "this app is reserved to some groups", roles };
    }
  }
  if (rule && !roles.includes(rule.role)) {
    return { ok: false, status: 403, reason: `this needs the ${rule.role} role`, roles };
  }
  return { ok: true, roles };
}

// The apps a person can open, for the account page. Mirrors decide() without a
// path: an app with only protected parts is still listed, it opens.
export function canOpen(app: AppPolicy, id: Identity, roles: string[]) {
  if (app.access !== "groups" || id.user.role === "admin") return true;
  const names = id.groups.map((g) => g.name);
  return app.groups.some((g) => names.includes(g)) || roles.length > 0;
}
