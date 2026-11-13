import { api } from "../../api.js";
import { toast } from "../../ui.js";
import { t } from "../../i18n.js";
import { state } from "../../state.js";
import { isAdmin } from "../../session.js";

// Gold price per Baht and the USD rate. Everyone can read them; only an admin can change them.
export async function renderGoldPrice(root) {
  const { config } = await api.settingsSummary();
  const canEdit = isAdmin(state.user);
  const lock = canEdit ? "" : "disabled";
  root.innerHTML = `
    <div class="card p-4">
      <label for="spot-price" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.spotPriceLabel")}</label>
      <input id="spot-price" type="number" min="0" step="1000" inputmode="numeric" value="${Number(config.spot_lak_per_baht) || ""}" ${lock} class="input-filled text-center font-extrabold" />
      <label for="usd-rate" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("settings.usdRateLabel")}</label>
      <input id="usd-rate" type="number" min="0" step="1" inputmode="numeric" value="${Number(config.usd_to_lak_rate) || ""}" ${lock} class="input-filled text-center font-extrabold" />
      <p class="mt-2 text-[11px] text-gray-500">${t("settings.priceHint")}</p>
      ${
        canEdit
          ? `<button id="save-config" class="btn-primary mt-4 w-full">${t("settings.save")}</button>`
          : `<p class="mt-3 text-center text-[11px] font-semibold text-gray-500">${t("settings.adminOnly")}</p>`
      }
    </div>`;

  root.querySelector("#save-config")?.addEventListener("click", async () => {
    const spot = Number(root.querySelector("#spot-price").value);
    const usd = Number(root.querySelector("#usd-rate").value);
    if (!(spot > 0)) return toast(t("settings.needSpotPrice"), "error");
    state.meta.config = await api.saveConfig({ spotLakPerBaht: spot, usdToLakRate: usd > 0 ? usd : 0 });
    toast(t("settings.savedToast"), "success");
  });
}
