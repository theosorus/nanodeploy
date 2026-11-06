// Who is looking at the app, for the frontend: an anonymous visitor, or a
// signed-in person with their roles in this app. The gateway answers /_nd/me on
// every app host, so a public app can show a "sign in" link to its moderators
// and a delete button once they are back.
export type Me =
  | { anonymous: true; login: string; logout: string }
  | {
      anonymous: false;
      id: string;
      username: string;
      name: string;
      email: string;
      groups: string[];
      roles: string[];
      admin: boolean;
      login: string;
      logout: string;
      account: string;
    };

export async function getMe(): Promise<Me> {
  // not through api(): this is the gateway answering, it never sleeps
  const res = await fetch("/_nd/me", { credentials: "same-origin" });
  if (!res.ok) return { anonymous: true, login: "/_nd/login", logout: "/_nd/logout" };
  return res.json();
}

export const hasRole = (me: Me | null, role: string) => Boolean(me && !me.anonymous && me.roles.includes(role));

// Links, not fetches: signing in goes through the sign-in page and comes back
// to `path` on this app.
export const loginUrl = (path = location.pathname + location.search) =>
  `/_nd/login?rd=${encodeURIComponent(path)}`;
export const logoutUrl = "/_nd/logout";
