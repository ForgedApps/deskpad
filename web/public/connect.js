// Where an AI client (over MCP) sends the browser so its user can sign in
// and approve it. The query string is written and signed by the server
// (`/api/auth/oauth2/authorize`); this page only hands it back, so nothing
// in it can be forged into an approval for a different app or address.
const $ = (id) => document.getElementById(id);
const show = (id) => ["v-loading", "v-auth", "v-approve", "v-done"].forEach((v) => ($(v).hidden = v !== id));
const params = new URLSearchParams(location.search);

/** The signed part of the query, as the server expects it back. */
function signedQuery() {
  if (!params.has("sig")) return "";
  const names = new Set(params.getAll("ba_param"));
  if (!names.size) return "";
  const out = new URLSearchParams();
  for (const [k, v] of params.entries()) if (k === "sig" || k === "ba_param" || names.has(k)) out.append(k, v);
  return out.toString();
}
const oauth_query = signedQuery();

async function api(path, body) {
  const res = await fetch(`/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error_description || data?.message || `Something went wrong (${res.status}).`);
  return data;
}

const fail = (text) => {
  $("done-text").textContent = text;
  show("v-done");
};

async function route() {
  if (!oauth_query) return fail("This page is opened by an app that wants to connect to Deskpad. Start from that app.");
  const me = await api("/get-session").catch(() => null);
  if (!me?.user) {
    if (params.get("error")) $("auth-error").textContent = "Google sign-in didn't complete, or this server isn't taking new accounts.";
    return show("v-auth");
  }
  $("who").textContent = me.user.email;
  let name = "";
  try {
    const c = await api(`/oauth2/public-client?client_id=${encodeURIComponent(params.get("client_id") ?? "")}`);
    name = typeof c?.client_name === "string" ? c.client_name : "";
  } catch {
    return fail("That app is not registered with this server any more. Start again from the app.");
  }
  $("client").textContent = name || "An app that gave no name";
  let host = "";
  try {
    host = new URL(params.get("redirect_uri") ?? "").host;
  } catch {}
  $("dest").textContent = host ? `It will be sent back to ${host}` : "";
  show("v-approve");
}

$("btn-google").addEventListener("click", async () => {
  const btn = $("btn-google");
  btn.disabled = true;
  $("auth-error").textContent = "";
  try {
    // Carrying the signed query lets the server pick the request up again after Google.
    const r = await api("/sign-in/social", { provider: "google", callbackURL: "/", errorCallbackURL: location.pathname + location.search, oauth_query });
    if (r?.url) location.href = r.url;
    else throw new Error("Google sign-in isn't set up on this server yet.");
  } catch (err) {
    $("auth-error").textContent = err.message;
    btn.disabled = false;
  }
});

for (const [id, accept] of [["btn-approve", true], ["btn-deny", false]]) {
  $(id).addEventListener("click", async () => {
    $("btn-approve").disabled = $("btn-deny").disabled = true;
    try {
      const r = await api("/oauth2/consent", { accept, oauth_query });
      if (!r?.url) throw new Error("The server gave no way back to the app.");
      location.href = r.url;
    } catch (err) {
      $("approve-error").textContent = err.message;
      $("btn-approve").disabled = $("btn-deny").disabled = false;
    }
  });
}

route();
