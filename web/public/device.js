const $ = (id) => document.getElementById(id);
const show = (id) => ["v-loading", "v-auth", "v-approve", "v-done"].forEach((v) => ($(v).hidden = v !== id));
const params = new URLSearchParams(location.search);
// What the Deskpad app put in the address when it opened this page: a PKCE
// challenge, the port it listens on at 127.0.0.1, and a value it checks.
const link = {
  challenge: params.get("challenge") ?? "",
  port: Number(params.get("port")),
  state: params.get("state") ?? "",
};
const fromApp = params.has("challenge") || params.has("port") || params.has("state");
const linkValid =
  /^[A-Za-z0-9_-]{43}$/.test(link.challenge) && Number.isInteger(link.port) && link.port >= 1024 && link.port <= 65535 && /^[A-Za-z0-9_-]{1,100}$/.test(link.state);
/** The app's own address on this computer; nothing else is ever sent a sign-in. */
const appUrl = (query) => `http://127.0.0.1:${link.port}/callback?${query}&state=${encodeURIComponent(link.state)}`;
// Where Google sends the browser back to: this page, without a stale error.
const keep = new URLSearchParams(params);
keep.delete("error");
const here = location.pathname + (keep.size ? `?${keep}` : "");

async function api(path, body) {
  const res = await fetch(`/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || data?.error_description || `Something went wrong (${res.status}).`);
  return data;
}

/** What a failed return from Google means, in plain words. */
function explain(code) {
  if (!code) return "";
  if (/signup|unable_to_create_user|forbidden/i.test(code)) return "This Deskpad server isn't taking new accounts.";
  if (/access_denied/i.test(code)) return "Google sign-in was cancelled.";
  return "Google sign-in didn't complete. Try again.";
}

async function route() {
  const me = await api("/get-session").catch(() => null);
  if (!me?.user) {
    $("auth-error").textContent = explain(params.get("error"));
    return show("v-auth");
  }
  if (params.has("user_code") || (fromApp && !linkValid)) {
    // An old-style link, or one that was cut or changed on the way.
    $("done-text").textContent = "This sign-in link doesn't work. Start again from Sign in in the Deskpad app.";
    $("done-text").className = "error";
    return show("v-done");
  }
  if (!fromApp) {
    $("done-text").textContent = `Signed in as ${me.user.email}.`;
    return show("v-done");
  }
  $("who").textContent = me.user.email;
  show("v-approve");
}

$("btn-google").addEventListener("click", async () => {
  const btn = $("btn-google");
  btn.disabled = true;
  $("auth-error").textContent = "";
  try {
    const r = await api("/sign-in/social", { provider: "google", callbackURL: here, errorCallbackURL: here });
    if (r?.url) location.href = r.url;
    else throw new Error("Google sign-in isn't set up on this server yet.");
  } catch (err) {
    $("auth-error").textContent = err.message;
    btn.disabled = false;
  }
});

$("btn-approve").addEventListener("click", async () => {
  $("btn-approve").disabled = true;
  $("approve-error").textContent = "";
  try {
    const res = await fetch("/api/v1/link/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(link),
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || typeof data?.url !== "string" || !data.url.startsWith(`http://127.0.0.1:${link.port}/`)) {
      throw new Error(data?.error || `Something went wrong (${res.status}).`);
    }
    // Hands the one-time code to the app on this computer, which shows its own "connected" page.
    location.href = data.url;
  } catch (err) {
    $("approve-error").textContent = err.message;
    $("btn-approve").disabled = false;
  }
});

$("btn-deny").addEventListener("click", () => {
  // Tells the waiting app to stop; it shows its own "cancelled" page.
  location.href = appUrl("error=access_denied");
});

$("btn-signout").addEventListener("click", async () => {
  await api("/sign-out", {}).catch(() => {});
  // The web app keeps notes and pictures in this browser; they go with the session.
  try {
    indexedDB.deleteDatabase("deskpad");
    for (const key of await caches.keys()) await caches.delete(key);
  } catch {}
  location.href = here;
});

fetch("/api/v1/auth-methods")
  .then((r) => r.json())
  .then((m) => {
    if (!m.google) {
      $("btn-google").disabled = true;
      $("auth-error").textContent = "Google sign-in isn't set up on this server yet.";
    }
  })
  .catch(() => {});
route();
