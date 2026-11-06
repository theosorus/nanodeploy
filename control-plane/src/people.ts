// Pocket ID is no longer the account system: gate is. This module only reads it,
// once, to import existing accounts and groups with their ids (accounts.ts).
const BASE = process.env.POCKETID_URL ?? "http://pocket-id:1411";
const KEY = process.env.POCKETID_API_KEY ?? "";

export const configured = () => KEY.length > 0;

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

export async function listGroups(): Promise<{ id: string; name: string }[]> {
  const payload = await call("/user-groups?pagination[limit]=200");
  return rows(payload).map((g: any) => ({ id: g.id, name: g.name ?? g.friendlyName }));
}
