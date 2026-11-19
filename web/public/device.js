const $ = (id) => document.getElementById(id);
const show = (id) => ["v-loading", "v-auth", "v-approve", "v-done"].forEach((v) => ($(v).hidden = v !== id));
const params = new URLSearchParams(location.search);
const userCode = (params.get("user_code") ?? "").trim();
// Where Google sends the browser back to: this page, without a stale error.
const here = location.pathname + (userCode ? `?user_code=${encodeURIComponent(userCode)}` : "");

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
  if (!userCode) {
    $("done-text").textContent = `Signed in as ${me.user.email}.`;
    return show("v-done");
  }
  try {
    // Claims the code for this account and reports where it stands.
    const state = await api(`/device?user_code=${encodeURIComponent(userCode)}`);
    if (state.status !== "pending") {
      $("done-text").textContent = state.status === "approved" ? "This PC is already connected. You can close this tab." : "That request was cancelled. Start again from the app.";
      return show("v-done");
    }
  } catch (err) {
    $("done-text").textContent = "That code is not valid any more. Start again from the Deskpad app.";
    $("done-text").className = "error";
    return show("v-done");
  }
  $("who").textContent = me.user.email;
  $("code").textContent = userCode;
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

for (const [id, path, text] of [
  ["btn-approve", "/device/approve", "Connected. You can close this tab and go back to Deskpad."],
  ["btn-deny", "/device/deny", "Cancelled. Nothing was connected."],
]) {
  $(id).addEventListener("click", async () => {
    $(id).disabled = true;
    try {
      await api(path, { userCode });
      $("done-text").textContent = text;
      show("v-done");
    } catch (err) {
      $("approve-error").textContent = err.message;
    } finally {
      $(id).disabled = false;
    }
  });
}

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
