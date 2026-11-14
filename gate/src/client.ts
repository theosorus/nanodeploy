// Browser side of passkeys, bundled into /static/gate.js. Three buttons, found
// by data attributes, so the pages stay plain server-rendered HTML.
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

const errorBox = () => document.getElementById("wa-error");

function showError(kind: "failed" | "unsupported") {
  const box = errorBox();
  if (!box) return;
  box.textContent = box.dataset[kind] ?? "";
  box.hidden = false;
}

async function post(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.login) location.assign(data.login);
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

async function signIn(button: HTMLElement) {
  try {
    const optionsJSON = await post("/webauthn/login/options", {});
    const response = await startAuthentication({ optionsJSON });
    const { redirect } = await post("/webauthn/login/verify", { response, to: button.dataset.to ?? "", st: button.dataset.st ?? "" });
    location.assign(redirect);
  } catch (err) {
    console.error(err);
    showError("failed");
  }
}

async function register(button: HTMLElement) {
  const token = button.dataset.token ?? null;
  const label = (document.getElementById("passkey-label") as HTMLInputElement | null)?.value.trim() ?? "";
  try {
    const optionsJSON = await post("/webauthn/register/options", { token });
    const response = await startRegistration({ optionsJSON });
    const { redirect } = await post("/webauthn/register/verify", { response, token, label });
    location.assign(redirect);
  } catch (err) {
    console.error(err);
    showError("failed");
  }
}

for (const el of document.querySelectorAll<HTMLElement>("[data-passkey-login], [data-passkey-register]")) {
  if (!browserSupportsWebAuthn()) {
    el.hidden = true;
    continue;
  }
  el.addEventListener("click", () => ("passkeyLogin" in el.dataset ? signIn(el) : register(el)));
}
