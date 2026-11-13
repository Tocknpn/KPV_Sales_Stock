import { HttpError, newRouter } from "./app";
import { StoreError } from "./store";
import { requireAuth } from "./auth";
import metaRoutes from "./routes/meta";
import authRoutes from "./routes/auth";
import stockRoutes from "./routes/stock";
import transferRoutes from "./routes/transfers";
import moveRoutes from "./routes/moves";
import documentRoutes from "./routes/documents";
import insightRoutes from "./routes/insights";
import settingsRoutes from "./routes/settings";
import caseRoutes from "./routes/cases";
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
app.route("/api", caseRoutes);
app.route("/api", replenishmentRoutes);
app.route("/api", auditRoutes);

const STORE_STATUS = { DAY_LOCKED: 423, CONFLICT: 409, INVALID: 400, UNAVAILABLE: 503, NEGATIVE: 409, AUDIT_ACTOR_MISSING: 500, DENIED: 403, IMMUTABLE: 409 } as const;

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, code: err.code ?? null, ...(err.extra ?? {}) }, err.status as 400);
  }
  if (err instanceof StoreError) {
    const message =
      err.code === "DAY_LOCKED"
        ? "This day is Done and locked for this Desk"
        : err.code === "UNAVAILABLE"
        ? "The database cannot be reached. Try again."
        : err.code === "NEGATIVE"
        ? "This would make the stock negative"
        : err.code === "DENIED"
        ? "You are not allowed to do that"
        : err.code === "IMMUTABLE"
        ? "An assignment can only be ended, never rewritten"
        : err.code === "CONFLICT"
        ? "That already exists or was changed on another device"
        : "The database rejected that value";
    console.error(`[store ${err.code}] ${err.message}`);
    return c.json(
      {
        error: message,
        code: err.code === "NEGATIVE" ? "NEGATIVE_CLOSING" : err.code === "DENIED" ? "ROLE_DENIED" : err.code === "IMMUTABLE" ? "ASSIGNMENT_IMMUTABLE" : err.code,
        ...(err.code === "NEGATIVE" && err.available !== undefined ? { available: err.available } : {}),
      },
      STORE_STATUS[err.code]
    );
  }
  console.error(err);
  return c.json({ error: "Something went wrong on the server", code: "SERVER_ERROR" }, 500);
});

app.notFound((c) => c.json({ error: "Not found", code: "NOT_FOUND" }, 404));

export default app;
