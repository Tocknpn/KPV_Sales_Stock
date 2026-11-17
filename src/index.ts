import { HttpError, newRouter } from "./app";
import { StoreError } from "./store";
import { storeErrorResponse } from "./storeErrors";
import { requireAuth } from "./auth";
import metaRoutes from "./routes/meta";
import authRoutes from "./routes/auth";
import stockRoutes from "./routes/stock";
import transferRoutes from "./routes/transfers";
import moveRoutes from "./routes/moves";
import documentRoutes from "./routes/documents";
import insightRoutes from "./routes/insights";
import settingsRoutes from "./routes/settings";
import closedDayRoutes from "./routes/closedDays";
import replenishmentRoutes from "./routes/replenishment";
import auditRoutes from "./routes/audit";

// The SPA and the API are served from the same origin, so no CORS headers are
// sent: other websites cannot call this API from a browser.
const app = newRouter();

// Public + login routes first (each guards itself), then everything else
// sits behind one requireAuth.
app.route("/api", authRoutes);
app.route("/api", metaRoutes);
app.use("/api/*", requireAuth);
app.route("/api", stockRoutes);
app.route("/api", transferRoutes);
app.route("/api", moveRoutes);
app.route("/api", documentRoutes);
app.route("/api", insightRoutes);
app.route("/api", settingsRoutes);
app.route("/api", closedDayRoutes);
app.route("/api", replenishmentRoutes);
app.route("/api", auditRoutes);

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, code: err.code ?? null, ...(err.extra ?? {}) }, err.status as 400);
  }
  if (err instanceof StoreError) {
    console.error(`[store ${err.code}] ${err.message}`);
    const { status, body } = storeErrorResponse(err);
    return c.json(body, status as 400);
  }
  console.error(err);
  return c.json({ error: "Something went wrong on the server", code: "SERVER_ERROR" }, 500);
});

app.notFound((c) => c.json({ error: "Not found", code: "NOT_FOUND" }, 404));

export default app;
