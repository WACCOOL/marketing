import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppBindings } from "./auth.js";
import { utmRoutes } from "./routes/utm.js";
import { vocabRoutes } from "./routes/vocab.js";
import { shortLinkRoutes } from "./routes/shortlinks.js";
import { qrRoutes } from "./routes/qr.js";
import { socialRoutes } from "./routes/social.js";
import { bulkRoutes } from "./routes/bulk.js";
import { assetRoutes } from "./routes/assets.js";
import { meRoutes } from "./routes/me.js";

const app = new Hono<AppBindings>();

app.use(
  "/api/*",
  cors({
    origin: (origin) => origin ?? "*",
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 600,
  }),
);

app.get("/api/_health", (c) => c.json({ ok: true }));

app.route("/api/me", meRoutes);
app.route("/api/utm", utmRoutes);
app.route("/api/vocab", vocabRoutes);
app.route("/api/short-links", shortLinkRoutes);
app.route("/api/qr", qrRoutes);
app.route("/api/social", socialRoutes);
app.route("/api/bulk", bulkRoutes);
app.route("/api/assets", assetRoutes);

// Anything not handled by a /api/* route falls through to the SPA assets
// (configured in wrangler.jsonc with not_found_handling: single-page-application).
app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
