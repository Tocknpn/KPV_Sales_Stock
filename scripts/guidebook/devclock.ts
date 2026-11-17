// Local demo only: the real app with a movable business date, so a guidebook
// test can live through "tomorrow" without restarting (a restart would wipe
// the in-memory demo store). Never deployed.
//
//   npx wrangler dev scripts/guidebook/devclock.ts --port 8790
//   GET /api/__clock            → { shift, date }
//   GET /api/__clock?days=1     → business date = real Laos date + 1
import app from "../../src/index";
import { addDays, isLive, laosDate } from "../../src/time";

let shift = 0;

export default {
  async fetch(req: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    if (isLive(env as never)) return new Response("devclock refuses to run against a real database", { status: 500 });
    const url = new URL(req.url);
    if (url.pathname === "/api/__clock") {
      const days = url.searchParams.get("days");
      if (days !== null && Number.isInteger(Number(days))) shift = Number(days);
      return Response.json({ shift, date: addDays(laosDate(), shift) });
    }
    return app.fetch(req, { ...env, DEMO_DATE: addDays(laosDate(), shift) }, ctx);
  },
};
