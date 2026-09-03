// Every API call goes through this client. It exists for one reason: the
// platform stops an app container after idle.timeout, and the first request
// that wakes it is answered by a short HTML waiting page (sablier) instead of
// JSON. The request never reached the backend, so retrying it is always safe.
// JSON errors pass through immediately, only the wake page triggers a retry.
const WAKE_RETRIES = 4;
const WAKE_RETRY_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ApiOptions = {
  // Called the first time a request lands on the waiting page. Show a "waking
  // up" state rather than a spinner: the wait is a second, but a silent spinner
  // on a first visit reads as a broken app.
  onWaking?: (attempt: number) => void;
};

export async function api<T>(path: string, init?: RequestInit, opts?: ApiOptions): Promise<T> {
  let res: Response | null = null;

  // sablier answers 200/503 with an HTML page while the container starts
  for (let attempt = 0; attempt <= WAKE_RETRIES; attempt++) {
    res = await fetch(path, init);
    const type = res.headers.get("content-type") ?? "";
    const waitingPage = (res.status === 200 || res.status === 503) && !type.includes("json");
    if (!waitingPage) break;
    opts?.onWaking?.(attempt + 1);
    if (attempt === WAKE_RETRIES) {
      throw new Error("le backend ne s'est pas réveillé à temps");
    }
    await sleep(WAKE_RETRY_MS);
  }

  const final = res as Response;
  if (!final.ok) {
    let message = final.statusText;
    try {
      const body = await final.json();
      message = body.error ?? message;
    } catch {
      // non-json error body (502 from the gateway, etc.)
    }
    throw new Error(message);
  }
  return (await final.json()) as T;
}
