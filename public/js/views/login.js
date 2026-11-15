// Full-screen login gate shown before the normal app chrome mounts:
// username + password -> session stored. Accounts live in Supabase
// (staff_accounts); an admin creates them in Settings > Users.
import { api } from "../api.js";
import { setSession, clearSession } from "../session.js";
import { t } from "../i18n.js";
import { escapeHtml } from "../util.js";

// The last username used on this device, so a returning person only types
// the password. Never the password itself.
const LAST_USER_KEY = "kpv_last_username";

function lastUsername() {
  try {
    return localStorage.getItem(LAST_USER_KEY) || "";
  } catch {
    return "";
  }
}

function rememberUsername(u) {
  try {
    localStorage.setItem(LAST_USER_KEY, u);
  } catch {}
}

// "Switch user" on a shared tablet: end the session and reopen login empty.
export async function switchUser() {
  try {
    await api.logout();
  } catch {}
  clearSession();
  try {
    localStorage.removeItem(LAST_USER_KEY);
  } catch {}
  window.location.reload();
}

const EYE = `<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a10.6 10.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;

export async function mountLogin(onSuccess) {
  document.getElementById("topbar-slot").innerHTML = "";
  document.getElementById("topbar").classList.add("hidden");
  document.getElementById("bottom-nav").classList.add("hidden");

  const root = document.getElementById("view-root");
  root.classList.add("pt-10");
  const remembered = lastUsername();

  root.innerHTML = `
    <form id="login-form" class="mx-auto flex w-full max-w-sm flex-col pt-10" novalidate>
      <h1 class="text-center text-2xl font-extrabold text-gray-900">${t("login.title")}</h1>
      <p class="mt-2 text-center text-sm text-gray-600">${t("login.subtitle")}</p>

      <label for="login-username" class="mb-1.5 mt-10 block text-sm font-bold text-gray-700">${t("login.username")}</label>
      <input id="login-username" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"
             maxlength="30" value="${escapeHtml(remembered)}" placeholder="${t("login.usernamePlaceholder")}" class="input-filled py-3 text-base" required />

      <label for="login-password" class="mb-1.5 mt-5 block text-sm font-bold text-gray-700">${t("login.password")}</label>
      <div class="relative">
        <input id="login-password" name="password" type="password" autocomplete="current-password" maxlength="72"
               placeholder="••••••••" class="input-filled py-3 pr-12 text-base" required />
        <button type="button" id="login-toggle" class="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-gray-500"
                aria-label="${t("login.showPassword")}" aria-pressed="false">${EYE_OFF}</button>
      </div>

      <p id="login-error" class="mt-3 min-h-[1.25rem] text-sm font-bold text-danger" role="alert"></p>

      <button id="login-submit" type="submit" class="btn-primary mt-3 w-full justify-center rounded-full py-3.5 text-base">${t("login.logIn")}</button>
      <p class="mt-6 text-center text-xs text-gray-500">${t("login.forgot")}</p>
    </form>`;

  const form = root.querySelector("#login-form");
  const userEl = root.querySelector("#login-username");
  const passEl = root.querySelector("#login-password");
  const errorEl = root.querySelector("#login-error");
  const submit = root.querySelector("#login-submit");
  const toggle = root.querySelector("#login-toggle");

  (remembered ? passEl : userEl).focus();

  toggle.addEventListener("click", () => {
    const show = passEl.type === "password";
    passEl.type = show ? "text" : "password";
    toggle.innerHTML = show ? EYE : EYE_OFF;
    toggle.setAttribute("aria-pressed", String(show));
    toggle.setAttribute("aria-label", t(show ? "login.hidePassword" : "login.showPassword"));
  });

  [userEl, passEl].forEach((el) => el.addEventListener("input", () => (errorEl.textContent = "")));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = userEl.value.trim().toLowerCase();
    const password = passEl.value;
    if (!username || !password) {
      errorEl.textContent = t("login.needBoth");
      (username ? passEl : userEl).focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = t("login.signingIn");
    try {
      const { token, user } = await api.login(username, password);
      rememberUsername(username);
      setSession(token, user);
      document.getElementById("topbar").classList.remove("hidden");
      document.getElementById("bottom-nav").classList.remove("hidden");
      root.classList.remove("pt-10");
      onSuccess(user);
    } catch (err) {
      errorEl.textContent = err.message || t("err.WRONG_LOGIN");
      passEl.value = "";
      passEl.focus();
      submit.disabled = false;
      submit.textContent = t("login.logIn");
    }
  });
}
