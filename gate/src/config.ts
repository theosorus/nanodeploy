// Everything gate needs to know about where it runs. The public scheme and port
// are what the browser sees (a tunnel in front terminates TLS), not what gate
// listens on.
export const DOMAIN = (process.env.APPS_DOMAIN ?? "").toLowerCase();
if (!DOMAIN.includes(".")) {
  console.error("APPS_DOMAIN must be set to the apps domain, e.g. apps.example.com");
  process.exit(1);
}

export const SCHEME = process.env.PUBLIC_SCHEME === "http" ? "http" : "https";
export const PUBLIC_PORT = process.env.PUBLIC_PORT ?? "";
const portSuffix = PUBLIC_PORT ? `:${PUBLIC_PORT}` : "";

// Off only for a local test stack served over plain http: secure cookies are
// what lets the __Host- prefix pin a cookie to one host.
export const SECURE_COOKIES = process.env.COOKIE_SECURE !== "false" || SCHEME === "https";

export const AUTH_HOST = `auth.${DOMAIN}`;
export const CONSOLE_HOST = `deploy.${DOMAIN}`;
export const originOf = (host: string) => `${SCHEME}://${host}${portSuffix}`;
export const AUTH_ORIGIN = originOf(AUTH_HOST);

// root session on the auth host, one host session per app host
export const ROOT_COOKIE = SECURE_COOKIES ? "__Host-nd_root" : "nd_root";
export const HOST_COOKIE = SECURE_COOKIES ? "__Host-nd_s" : "nd_s";
export const WEBAUTHN_COOKIE = SECURE_COOKIES ? "__Host-nd_wa" : "nd_wa";
// set on an app host when it sends a browser to sign in, checked when the
// browser comes back: a sign-in started elsewhere cannot be finished here
export const STATE_COOKIE = SECURE_COOKIES ? "__Host-nd_st" : "nd_st";
export const STATE_TTL = 600;

// passkeys are made for the parent domain: one passkey works for the auth host
// whatever the apps are called
export const RP_ID = DOMAIN;
export const RP_NAME = "Nanodeploy";

export const DAY = 86_400_000;
export const ROOT_TTL = 30 * DAY;
// the console can deploy code: whoever drives it proved who they are recently
export const CONSOLE_FRESH = 12 * 3_600_000;

export const CONSOLE = "__console";
const SLUG_RE = /^[a-z][a-z0-9-]{1,62}$/;
const RESERVED = new Set(["deploy", "auth", "id", "www"]);

// Which app a host belongs to, or the console, or null for anything gate does
// not serve. The port is ignored: the browser may add one, caddy does not care.
export function slugOfHost(rawHost: string | undefined): string | null {
  const host = (rawHost ?? "").toLowerCase().replace(/:\d+$/, "");
  if (host === CONSOLE_HOST) return CONSOLE;
  if (!host.endsWith(`.${DOMAIN}`)) return null;
  const label = host.slice(0, -DOMAIN.length - 1);
  if (!SLUG_RE.test(label) || RESERVED.has(label)) return null;
  return label;
}

export const hostOfSlug = (slug: string) => (slug === CONSOLE ? CONSOLE_HOST : `${slug}.${DOMAIN}`);
