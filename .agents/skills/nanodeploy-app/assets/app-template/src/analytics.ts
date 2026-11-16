// Page views of a single-page app. The first load is counted by the gateway
// already (it sees the HTML request); later navigations happen in the browser
// and the server never hears of them. Call trackPage() after each client-side
// route change, never on the first render, or that view counts twice.
// No cookie, no third party: the beacon goes to this app's own host, where the
// gateway answers it with an empty 204 and logs it.
export function trackPage(path: string = location.pathname) {
  const url = `/_nd/e?p=${encodeURIComponent(path.slice(0, 200))}`;
  if (!navigator.sendBeacon?.(url)) {
    fetch(url, { method: "POST", keepalive: true }).catch(() => {});
  }
}
