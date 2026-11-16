import { api } from "../../api.js";
import { toast } from "../../ui.js";
import { t } from "../../i18n.js";
import { state } from "../../state.js";

// Company-wide: how staff enter stock-out on the stock grid. Admin only (the
// menu entry is hidden for others; the server refuses them too). Each case-day
// keeps the mode it was opened in, so a change shows from the next opened day.
export async function renderStockOutMode(root) {
  const { config } = await api.settingsSummary();
  let mode = config.stock_out_mode === "single" ? "single" : "dynamic";

  const option = (value, title, hint) => `
    <label class="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 ${mode === value ? "border-brand-500 bg-brand-50" : "border-hairline bg-white"}">
      <input type="radio" name="stock-out-mode" value="${value}" ${mode === value ? "checked" : ""} class="mt-0.5 h-5 w-5 shrink-0 accent-brand-600" />
      <span class="min-w-0">
        <span class="block text-sm font-extrabold text-gray-900">${title}</span>
        <span class="mt-0.5 block text-xs text-gray-600">${hint}</span>
      </span>
    </label>`;

  const paint = () => {
    root.innerHTML = `
      <div class="card p-4">
        <p class="mb-3 text-xs font-semibold text-gray-600">${t("stockOut.intro")}</p>
        <div class="flex flex-col gap-2.5">
          ${option("single", t("stockOut.single"), t("stockOut.singleHint"))}
          ${option("dynamic", t("stockOut.dynamic"), t("stockOut.dynamicHint"))}
        </div>
        <p class="mt-3 rounded-lg bg-warning-bg px-3 py-2 text-[11px] font-semibold text-warning">${t("stockOut.appliesNext")}</p>
        <button id="save-stock-out-mode" class="btn-primary mt-4 w-full">${t("settings.save")}</button>
      </div>`;
    root.querySelectorAll('input[name="stock-out-mode"]').forEach((input) =>
      input.addEventListener("change", () => {
        mode = input.value;
        paint();
      })
    );
    const save = root.querySelector("#save-stock-out-mode");
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const updated = await api.saveConfig({ stockOutMode: mode });
        if (state.meta) state.meta.config = updated;
        toast(t("stockOut.saved"), "success");
      } finally {
        save.disabled = false;
      }
    });
  };
  paint();
}
