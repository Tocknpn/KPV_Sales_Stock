import { api } from "../../api.js";
import { toast } from "../../ui.js";
import { t } from "../../i18n.js";
import { state } from "../../state.js";

// USD -> LAK rate used for the Dashboard's USD figure. Admin only (the menu entry is hidden for others).
export async function renderExchangeRate(root) {
  const { config } = await api.settingsSummary();
  root.innerHTML = `
    <div class="card p-4">
      <label for="usd-rate" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.usdRateLabel")}</label>
      <input id="usd-rate" type="number" min="0" step="1" inputmode="numeric" value="${Number(config.usd_to_lak_rate) || ""}" class="input-filled text-center font-extrabold" />
      <p class="mt-2 text-[11px] text-gray-500">${t("settings.usdRateHint")}</p>
      <button id="save-config" class="btn-primary mt-4 w-full">${t("settings.save")}</button>
    </div>`;

  root.querySelector("#save-config").addEventListener("click", async () => {
    const usd = Number(root.querySelector("#usd-rate").value);
    state.meta.config = await api.saveConfig({ usdToLakRate: usd > 0 ? usd : 0 });
    toast(t("settings.savedToast"), "success");
  });
}
