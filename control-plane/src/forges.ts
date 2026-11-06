import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import * as secrets from "./secrets.js";

// One interface over GitHub (a GitHub App, created from the dashboard with the
// manifest flow) and GitLab (a project access token). Everything after "the
// archive of this commit is downloaded" is shared.

export const GITHUB_API = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
export const GITHUB_WEB = (process.env.GITHUB_URL ?? "https://github.com").replace(/\/$/, "");
export const GITLAB_URL = (process.env.GITLAB_URL ?? "https://gitlab.com").replace(/\/$/, "");

export type ProviderRow = {
  id: string;
  kind: "github" | "gitlab";
  name: string;
  config: any;
  secret_enc: string;
  webhook_secret_enc: string;
};

export type Repo = { id: string; fullName: string; defaultBranch: string };
export type Commit = { sha: string; message: string; author: string };
export type State = "pending" | "success" | "failure";

export type GitEvent =
  | { kind: "push"; repoId: string; branch: string; sha: string; message: string; author: string }
  | { kind: "pr"; action: "open" | "update" | "close"; repoId: string; number: number; base: string; head: string; sha: string; fromFork: boolean; message: string; author: string };

export interface Forge {
  verify(headers: Headers, body: Buffer): boolean;
  deliveryId(headers: Headers): string | null;
  parse(headers: Headers, payload: any): GitEvent | null;
  repos(): Promise<Repo[]>;
  head(repo: string, branch: string): Promise<Commit>;
  file(repo: string, ref: string, path: string): Promise<string | null>;
  archive(repo: string, sha: string): Promise<Buffer>;
  status(repo: string, sha: string, state: State, url: string, description: string): Promise<void>;
  comment(repo: string, pr: number, body: string, existing: string | null): Promise<string | null>;
}

const MAX_ARCHIVE = 200 * 1024 * 1024;

async function readCapped(res: Response): Promise<Buffer> {
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_ARCHIVE) throw new Error("repository archive larger than 200 MB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_ARCHIVE) throw new Error("repository archive larger than 200 MB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/* ---------- GitHub ---------- */

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

// A GitHub App authenticates as itself with a short JWT signed by its private
// key, then asks for an installation token (one hour) per repository owner.
// Nothing long-lived ever leaves the control plane.
function appJwt(appId: string, pem: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem);
  return `${head}.${body}.${b64url(sig)}`;
}

function github(p: ProviderRow): Forge {
  const appId = String(p.config.appId);
  const pem = () => secrets.open(p.secret_enc);
  const hookSecret = () => secrets.open(p.webhook_secret_enc);
  const tokens = new Map<string, { token: string; until: number }>();

  async function gh(path: string, init: RequestInit & { auth: string }) {
    const res = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "nanodeploy",
        authorization: init.auth,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    return res;
  }

  async function json(path: string, init: RequestInit & { auth: string }) {
    const res = await gh(path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`github ${res.status} on ${path.split("?")[0]}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  // the installation that covers this repository's owner
  async function tokenFor(repo: string) {
    const owner = repo.split("/")[0];
    const cached = tokens.get(owner);
    if (cached && cached.until > Date.now()) return cached.token;
    const jwt = `Bearer ${appJwt(appId, pem())}`;
    const inst = await json(`/repos/${repo}/installation`, { auth: jwt });
    const t = await json(`/app/installations/${inst.id}/access_tokens`, { method: "POST", auth: jwt });
    tokens.set(owner, { token: t.token, until: new Date(t.expires_at).getTime() - 300_000 });
    return t.token as string;
  }

  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");

  return {
    verify(headers, body) {
      const given = headers.get("x-hub-signature-256") ?? "";
      const expected = `sha256=${createHmac("sha256", hookSecret()).update(body).digest("hex")}`;
      return safeEqual(given, expected);
    },
    deliveryId: (headers) => headers.get("x-github-delivery"),
    parse(headers, e) {
      const event = headers.get("x-github-event");
      if (event === "push") {
        if (e.deleted || !String(e.ref ?? "").startsWith("refs/heads/")) return null;
        return {
          kind: "push",
          repoId: String(e.repository?.id),
          branch: e.ref.slice("refs/heads/".length),
          sha: e.after,
          message: e.head_commit?.message ?? "",
          author: e.head_commit?.author?.username ?? e.head_commit?.author?.name ?? e.pusher?.name ?? "",
        };
      }
      if (event === "pull_request") {
        const action = ["opened", "reopened", "synchronize"].includes(e.action) ? (e.action === "synchronize" ? "update" : "open")
          : e.action === "closed" ? "close" : null;
        if (!action) return null;
        const pr = e.pull_request;
        return {
          kind: "pr",
          action,
          repoId: String(e.repository?.id),
          number: Number(pr.number),
          base: pr.base?.ref,
          head: pr.head?.ref,
          sha: pr.head?.sha,
          fromFork: String(pr.head?.repo?.id) !== String(pr.base?.repo?.id),
          message: pr.title ?? "",
          author: pr.user?.login ?? "",
        };
      }
      return null;
    },
    async repos() {
      const jwt = `Bearer ${appJwt(appId, pem())}`;
      const installs = await json(`/app/installations?per_page=100`, { auth: jwt });
      const out: Repo[] = [];
      for (const inst of installs) {
        const t = await json(`/app/installations/${inst.id}/access_tokens`, { method: "POST", auth: jwt });
        const list = await json(`/installation/repositories?per_page=100`, { auth: `token ${t.token}` });
        for (const r of list.repositories ?? []) out.push({ id: String(r.id), fullName: r.full_name, defaultBranch: r.default_branch });
      }
      return out;
    },
    async head(repo, branch) {
      const c = await json(`/repos/${enc(repo)}/commits/${encodeURIComponent(branch)}`, { auth: `token ${await tokenFor(repo)}` });
      return { sha: c.sha, message: c.commit?.message ?? "", author: c.author?.login ?? c.commit?.author?.name ?? "" };
    },
    async file(repo, ref, path) {
      const res = await gh(`/repos/${enc(repo)}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`, {
        auth: `token ${await tokenFor(repo)}`,
        headers: { accept: "application/vnd.github.raw" },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github ${res.status} reading ${path}`);
      return res.text();
    },
    async archive(repo, sha) {
      // redirects to a pre-signed download: fetch drops the token on the way
      const res = await gh(`/repos/${enc(repo)}/tarball/${sha}`, { auth: `token ${await tokenFor(repo)}` });
      if (!res.ok) throw new Error(`github ${res.status} downloading ${repo}@${sha.slice(0, 7)}`);
      return readCapped(res);
    },
    async status(repo, sha, state, url, description) {
      await json(`/repos/${enc(repo)}/statuses/${sha}`, {
        method: "POST",
        auth: `token ${await tokenFor(repo)}`,
        body: JSON.stringify({ state, target_url: url, description: description.slice(0, 140), context: "nanodeploy" }),
      });
    },
    async comment(repo, pr, body, existing) {
      const auth = `token ${await tokenFor(repo)}`;
      if (existing) {
        await json(`/repos/${enc(repo)}/issues/comments/${existing}`, { method: "PATCH", auth, body: JSON.stringify({ body }) });
        return existing;
      }
      const c = await json(`/repos/${enc(repo)}/issues/${pr}/comments`, { method: "POST", auth, body: JSON.stringify({ body }) });
      return String(c.id);
    },
  };
}

// The manifest flow: the dashboard posts this to GitHub, the person confirms,
// GitHub sends them back with a code the control plane trades for the app's
// id, private key and webhook secret. Permissions are the least the job needs.
// The webhook URL is fixed before the app exists: deliveries are matched to the
// app by the X-GitHub-Hook-Installation-Target-ID header (the app id).
export function githubManifest(name: string, consoleOrigin: string) {
  return {
    name,
    url: consoleOrigin,
    hook_attributes: { url: `${consoleOrigin}/hooks/github`, active: true },
    redirect_url: `${consoleOrigin}/api/git/github/callback`,
    public: false,
    default_permissions: { contents: "read", metadata: "read", statuses: "write", pull_requests: "write" },
    default_events: ["push", "pull_request"],
  };
}

export async function githubConvert(code: string) {
  const res = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "nanodeploy" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`github ${res.status}: ${text.slice(0, 200)}`);
  const app = JSON.parse(text);
  return { id: String(app.id), slug: app.slug as string, htmlUrl: app.html_url as string, pem: app.pem as string, webhookSecret: app.webhook_secret as string };
}

/* ---------- GitLab ---------- */

async function glFetch(base: string, token: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}/api/v4${path}`, {
    ...init,
    headers: { "private-token": token, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
}

async function glJson(base: string, token: string, path: string, init: RequestInit = {}) {
  const res = await glFetch(base, token, path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`gitlab ${res.status} on ${path.split("?")[0]}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Checks the token on the project and installs the webhook. One provider per
// GitLab project: a project access token only ever sees its own project.
export async function gitlabConnect(project: string, token: string, hookUrl: string, hookSecret: string) {
  const p = await glJson(GITLAB_URL, token, `/projects/${encodeURIComponent(project)}`);
  const hook = await glJson(GITLAB_URL, token, `/projects/${p.id}/hooks`, {
    method: "POST",
    body: JSON.stringify({
      url: hookUrl,
      token: hookSecret,
      push_events: true,
      merge_requests_events: true,
      enable_ssl_verification: hookUrl.startsWith("https:"),
    }),
  });
  return { projectId: String(p.id), path: p.path_with_namespace as string, defaultBranch: p.default_branch as string, hookId: String(hook.id) };
}

export async function gitlabDisconnect(p: ProviderRow) {
  await glFetch(GITLAB_URL, secrets.open(p.secret_enc), `/projects/${p.config.projectId}/hooks/${p.config.hookId}`, { method: "DELETE" });
}

function gitlab(p: ProviderRow): Forge {
  const token = () => secrets.open(p.secret_enc);
  const id = String(p.config.projectId);
  const j = (path: string, init: RequestInit = {}) => glJson(GITLAB_URL, token(), path, init);
  return {
    verify(headers) {
      return safeEqual(headers.get("x-gitlab-token") ?? "", secrets.open(p.webhook_secret_enc));
    },
    deliveryId: (headers) => headers.get("x-gitlab-event-uuid") ?? headers.get("idempotency-key"),
    parse(headers, e) {
      const event = headers.get("x-gitlab-event");
      if (event === "Push Hook") {
        if (!e.checkout_sha || !String(e.ref ?? "").startsWith("refs/heads/")) return null;
        const last = (e.commits ?? []).find((c: any) => c.id === e.checkout_sha);
        return {
          kind: "push",
          repoId: String(e.project_id ?? e.project?.id),
          branch: e.ref.slice("refs/heads/".length),
          sha: e.checkout_sha,
          message: last?.message ?? "",
          author: e.user_username ?? e.user_name ?? "",
        };
      }
      if (event === "Merge Request Hook") {
        const a = e.object_attributes ?? {};
        // "update" also fires for a new title; only a new commit (oldrev) rebuilds
        const action = ["open", "reopen"].includes(a.action) ? "open"
          : a.action === "update" && a.oldrev ? "update"
          : ["close", "merge"].includes(a.action) ? "close" : null;
        if (!action) return null;
        return {
          kind: "pr",
          action,
          repoId: String(a.target_project_id ?? e.project?.id),
          number: Number(a.iid),
          base: a.target_branch,
          head: a.source_branch,
          sha: a.last_commit?.id,
          fromFork: String(a.source_project_id) !== String(a.target_project_id),
          message: a.title ?? "",
          author: e.user?.username ?? "",
        };
      }
      return null;
    },
    async repos() {
      return [{ id, fullName: p.config.path, defaultBranch: p.config.defaultBranch ?? "main" }];
    },
    async head(_repo, branch) {
      const b = await j(`/projects/${id}/repository/branches/${encodeURIComponent(branch)}`);
      return { sha: b.commit.id, message: b.commit.message ?? "", author: b.commit.author_name ?? "" };
    },
    async file(_repo, ref, path) {
      const res = await glFetch(GITLAB_URL, token(), `/projects/${id}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`gitlab ${res.status} reading ${path}`);
      return res.text();
    },
    async archive(_repo, sha) {
      const res = await glFetch(GITLAB_URL, token(), `/projects/${id}/repository/archive.tar.gz?sha=${encodeURIComponent(sha)}`);
      if (!res.ok) throw new Error(`gitlab ${res.status} downloading ${sha.slice(0, 7)}`);
      return readCapped(res);
    },
    async status(_repo, sha, state, url, description) {
      await j(`/projects/${id}/statuses/${sha}`, {
        method: "POST",
        body: JSON.stringify({ state: state === "failure" ? "failed" : state, target_url: url, name: "nanodeploy", description: description.slice(0, 140) }),
      });
    },
    async comment(_repo, mr, body, existing) {
      if (existing) {
        await j(`/projects/${id}/merge_requests/${mr}/notes/${existing}`, { method: "PUT", body: JSON.stringify({ body }) });
        return existing;
      }
      const n = await j(`/projects/${id}/merge_requests/${mr}/notes`, { method: "POST", body: JSON.stringify({ body }) });
      return String(n.id);
    },
  };
}

export const forgeOf = (p: ProviderRow): Forge => (p.kind === "github" ? github(p) : gitlab(p));
