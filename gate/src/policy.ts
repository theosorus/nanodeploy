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

function decodeOnce(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path.replace(/(?:%[0-9a-f]{2})+/gi, (s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
  }
}

// The request path as sent, then each further percent-decoding of it, four at
// most: what the backend, a framework or a file server may each end up reading.
function decodings(uri: string): string[] {
  const out = [uri.split("?")[0] || "/"];
  for (let depth = 0; depth < 4; depth++) {
    const next = decodeOnce(out[out.length - 1]);
    if (next === out[out.length - 1]) break;
    out.push(next);
  }
  return out;
}

// Do not feed a leading double slash to URL: it treats the first segment as a
// hostname and drops it.
function resolveDots(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  const trailing = /(?:\/|\/\.|\/\.\.)$/.test(path) && segments.length > 0 ? "/" : "";
  return "/" + segments.join("/") + trailing;
}

// The fully decoded path, including encoded separators, with dot segments
// resolved: the spelling a file server acts on.
export function normalizePath(uri: string): string {
  const all = decodings(uri);
  return resolveDots(all[all.length - 1].replace(/\\/g, "/")).toLowerCase();
}

// Every spelling of the path that some layer may route on. Resolving "/../"
// after decoding "%2f" can walk out of a protected prefix ("/api/admin/..%2f.."
// reads as "/"), while a router that leaves "%2f" alone still dispatches the
// request under that prefix. A rule therefore applies as soon as one spelling
// matches: at each decoding depth, the path with its dot segments kept and
// with them resolved.
export function pathSpellings(uri: string): string[] {
  const spellings = new Set<string>();
  for (const decoded of decodings(uri)) {
    const path = decoded.replace(/\\/g, "/");
    spellings.add(path.replace(/\/{2,}/g, "/").toLowerCase());
    spellings.add(resolveDots(path).toLowerCase());
  }
  return [...spellings];
}

export function matchPath(pattern: string, path: string): boolean {
  const p = pattern.toLowerCase();
  if (p.endsWith("*")) {
    const prefix = p.slice(0, -1);
    return path.startsWith(prefix) || (prefix.endsWith("/") && path === prefix.slice(0, -1));
  }
  return path.replace(/\/+$/, "") === p.replace(/\/+$/, "");
}

const matchingRules = (app: AppPolicy, uri: string) => {
  const spellings = pathSpellings(uri);
  return app.protect.filter((rule) => spellings.some((path) => matchPath(rule.path, path)));
};

export function protectRule(app: AppPolicy, uri: string) {
  return matchingRules(app, uri)[0] ?? null;
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
  const rules = matchingRules(app, uri);
  const needUser = app.access !== "public" || rules.length > 0;

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
  // All matching requirements apply. A broad rule listed first must never
  // hide a stronger rule on the application's administrative subtree.
  const rule = rules.find((rule) => !roles.includes(rule.role));
  if (rule) {
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
