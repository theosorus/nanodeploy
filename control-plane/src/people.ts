const BASE = process.env.POCKETID_URL ?? "http://pocket-id:1411";
const KEY = process.env.POCKETID_API_KEY ?? "";

export const configured = () => KEY.length > 0;

// ids come from the client: never let one steer the request to another endpoint
const enc = (s: string) => encodeURIComponent(String(s));

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      "X-API-KEY": KEY,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`pocket-id ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export type Person = {
  id: string;
  username: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  groups: string[];
};

// Pocket ID paginates list endpoints and wraps rows under `data`.
function rows(payload: any): any[] {
  return Array.isArray(payload) ? payload : (payload?.data ?? []);
}

export async function listPeople(): Promise<Person[]> {
  const [users, groups] = await Promise.all([
    call("/users?pagination[limit]=200"),
    call("/user-groups?pagination[limit]=200").catch(() => null),
  ]);
  const groupNames = new Map<string, string>(
    rows(groups).map((g: any) => [g.id, g.name ?? g.friendlyName]),
  );
  return rows(users).map((u: any) => ({
    id: u.id,
    username: u.username,
    email: u.email ?? "",
    displayName: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username,
    isAdmin: Boolean(u.isAdmin),
    groups: (u.userGroups ?? []).map((g: any) => g.name ?? groupNames.get(g.id) ?? g.id),
  }));
}

// A tinyauth session carries the groups the person had when they signed in.
// Adding yourself to the admin group and then naming it would therefore lock
// you out of your own console until you signed out and back in. Ask the
// identity provider instead, cached so this stays cheap on a per-request path.
let cache: { at: number; people: Person[] } | null = null;
const CACHE_MS = 60_000;

export async function groupsOf(sub: string, email: string): Promise<string[]> {
  if (!configured()) return [];
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const list = await listPeople().catch(() => null);
    if (!list) return [];
    cache = { at: Date.now(), people: list };
  }
  const found = cache.people.find(
    (p) => p.id === sub || (email && p.email.toLowerCase() === email.toLowerCase()),
  );
  return found?.groups ?? [];
}

// group edits must be visible on the next request, not up to a minute later
export const forgetGroups = () => (cache = null);

export async function listGroups(): Promise<{ id: string; name: string }[]> {
  const payload = await call("/user-groups?pagination[limit]=200");
  return rows(payload).map((g: any) => ({ id: g.id, name: g.name ?? g.friendlyName }));
}

// Creates the account and returns a one-time link. Pocket ID is passkey-based,
// so there is no password to send: the person follows the link and enrolls.
export async function invite(input: {
  username: string;
  email: string;
  firstName?: string;
}) {
  const user = await call("/users", {
    method: "POST",
    body: JSON.stringify({
      username: input.username,
      email: input.email,
      firstName: input.firstName ?? input.username,
      lastName: "",
      isAdmin: false,
    }),
  });
  const token = await call(`/users/${enc(user.id)}/one-time-access-token`, {
    method: "POST",
    body: JSON.stringify({
      expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
    }),
  }).catch(() => null);
  return {
    user,
    link: token?.token
      ? `${process.env.POCKETID_PUBLIC_URL ?? BASE}/lc/${token.token}`
      : null,
  };
}

export async function setGroups(userId: string, groupIds: string[]) {
  forgetGroups();
  return call(`/users/${enc(userId)}/user-groups`, {
    method: "PUT",
    body: JSON.stringify({ userGroupIds: groupIds }),
  });
}

export async function createGroup(name: string) {
  return call("/user-groups", {
    method: "POST",
    body: JSON.stringify({ name, friendlyName: name }),
  });
}

export async function removePerson(userId: string) {
  forgetGroups();
  return call(`/users/${enc(userId)}`, { method: "DELETE" });
}
