// Full-screen login gate shown before the normal app chrome mounts. Flow:
// Branch (or Owner/Admin) -> pick your name -> PIN pad -> session stored.
import { api } from "../api.js";
import { setSession } from "../session.js";
import { toast } from "../ui.js";
import { t } from "../i18n.js";

export async function mountLogin(branches, onSuccess) {
  document.getElementById("topbar-slot").innerHTML = "";
  document.getElementById("topbar").classList.add("hidden");
  document.getElementById("bottom-nav").classList.add("hidden");

  let step = "start"; // start -> account -> pin
  let selectedBranchId = null;
  let selectedAccount = null;
  let pin = "";
  let error = "";

  const root = document.getElementById("view-root");
  root.classList.add("pt-10");

  async function render() {
    if (step === "start") {
      root.innerHTML = `
        <div class="flex flex-col items-center pt-10">
          <h1 class="text-xl font-extrabold text-gray-900">${t("login.title")}</h1>
          <p class="mt-1 text-center text-xs font-medium text-gray-600">${t("login.subtitle")}</p>
          <div class="mt-8 flex w-full flex-col gap-2.5">
            ${branches
              .map((b) => `<button data-branch="${b.branch_id}" class="btn-secondary w-full justify-center py-3">${b.name_en}${b.name_lo ? ` · ${b.name_lo}` : ""}</button>`)
              .join("")}
            <button data-admin class="btn-primary mt-3 w-full justify-center py-3">${t("login.ownerLogin")}</button>
          </div>
        </div>`;
      root.querySelectorAll("[data-branch]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          selectedBranchId = btn.dataset.branch;
          step = "account";
          await render();
        })
      );
      root.querySelector("[data-admin]").addEventListener("click", async () => {
        selectedBranchId = null;
        step = "account";
        await render();
      });
      return;
    }

    if (step === "account") {
      root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">${t("login.loadingAccounts")}</div>`;
      const { accounts } = await api.authAccounts(selectedBranchId);
      root.innerHTML = `
        <div class="flex flex-col items-center pt-6">
          <button data-back class="self-start text-xs font-bold text-gray-500">&larr; ${t("login.back")}</button>
          <h1 class="mt-4 text-lg font-extrabold text-gray-900">${t("login.whoAreYou")}</h1>
          <div class="mt-6 flex w-full flex-col gap-2">
            ${
              accounts.length
                ? accounts
                    .map(
                      (a) => `<button data-account="${a.id}" class="card flex items-center gap-3 p-3.5 text-left">
                  <span class="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-sm font-extrabold text-brand-700">${a.display_name.slice(0, 2).toUpperCase()}</span>
                  <span class="text-sm font-bold text-gray-900">${a.display_name}</span>
                </button>`
                    )
                    .join("")
                : `<div class="py-8 text-center text-sm text-gray-500">${t("login.noAccounts")}</div>`
            }
          </div>
        </div>`;
      root.querySelector("[data-back]").addEventListener("click", async () => {
        step = "start";
        await render();
      });
      root.querySelectorAll("[data-account]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          selectedAccount = accounts.find((a) => a.id === btn.dataset.account);
          pin = "";
          error = "";
          step = "pin";
          await render();
        })
      );
      return;
    }

    // step === "pin"
    root.innerHTML = `
      <div class="flex flex-col items-center pt-6">
        <button data-back class="self-start text-xs font-bold text-gray-500">&larr; ${t("login.back")}</button>
        <h1 class="mt-4 text-lg font-extrabold text-gray-900">${selectedAccount.display_name}</h1>
        <p class="text-xs text-gray-600">${t("login.enterPin")}</p>
        <div class="mt-5 flex gap-2.5" id="pin-dots">
          ${[0, 1, 2, 3].map((i) => `<span class="h-3.5 w-3.5 rounded-full border-2 ${i < pin.length ? "border-brand-600 bg-brand-600" : "border-gray-300"}"></span>`).join("")}
        </div>
        ${error ? `<p class="mt-3 text-xs font-bold text-danger">${error}</p>` : ""}
        <div class="mt-6 grid w-full max-w-[280px] grid-cols-3 gap-3">
          ${["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"]
            .map((k) =>
              k === ""
                ? `<span></span>`
                : `<button data-key="${k}" class="tap-target rounded-2xl border border-hairline bg-white py-4 text-lg font-extrabold text-gray-800 active:bg-gray-50">${k === "back" ? "⌫" : k}</button>`
            )
            .join("")}
        </div>
        <button id="pin-submit" class="btn-primary mt-6 w-full max-w-[280px] py-3" ${pin.length < 4 ? "disabled" : ""}>${t("login.logIn")}</button>
      </div>`;

    root.querySelector("[data-back]").addEventListener("click", async () => {
      step = "account";
      await render();
    });
    root.querySelectorAll("[data-key]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const k = btn.dataset.key;
        if (k === "back") pin = pin.slice(0, -1);
        else if (pin.length < 8) pin += k;
        error = "";
        await render();
      })
    );
    root.querySelector("#pin-submit").addEventListener("click", async () => {
      try {
        const { token, user } = await api.login(selectedAccount.id, pin);
        setSession(token, user);
        document.getElementById("topbar").classList.remove("hidden");
        document.getElementById("bottom-nav").classList.remove("hidden");
        root.classList.remove("pt-10");
        onSuccess(user);
      } catch (err) {
        error = err.message || t("login.wrongPin");
        pin = "";
        toast(error, "error");
        await render();
      }
    });
  }

  await render();
}
