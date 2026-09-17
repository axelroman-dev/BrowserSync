import "express-async-errors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { syncRouter } from "./routes/sync.js";
import { healthRouter } from "./routes/health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Needed for express-rate-limit (and req.ip generally) to see the real
// client IP instead of the reverse proxy's, in the single-proxy deployments
// this project documents - see config.ts for how to tune the hop count.
app.set("trust proxy", config.trustProxyHops);

app.use(helmet());
app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",") }));
app.use(compression());
// A little headroom over maxBlobBytes for JSON envelope overhead (field names, base64 padding).
app.use(express.json({ limit: config.maxBlobBytes + 1024 * 64 }));

app.use("/api/health", healthRouter);
// authRateLimit is applied per-route inside authRouter (only to
// register/login/refresh/reset-password - the credential-guessing-sensitive
// ones), not here router-wide - it used to cover every /api/auth/* route,
// so routine authenticated calls like the dashboard's GET /me and GET
// /devices silently burned the same 20-per-15-min budget as login attempts,
// and a few dashboard page loads could lock someone out of their own
// account with "Too many attempts."
app.use("/api/auth", authRouter);
app.use("/api/sync", syncRouter);

// Static assets: the landing page (public/index.html, served automatically as
// the directory index for "/") and the account dashboard (public/dashboard/).
// The dashboard is a no-build vanilla JS page that logs in against the same
// /api/auth endpoints above and shows account email, linked devices, and
// per-data-type sync status (version/size/last updated) - metadata only,
// since the server never holds the key to decrypt the actual blobs. Both
// pages are served from this same origin/port so they can call the API with
// same-origin fetch()es, no CORS configuration needed.
app.use(express.static(path.join(__dirname, "../public")));

// Centralized error handler so an unexpected exception never leaks a stack
// trace to a client - the actual error still goes to the server's own logs.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal_error", message: "Something went wrong." });
});

app.listen(config.port, () => {
  console.log(`BrowserSync server listening on port ${config.port}`);
  console.log(`Registration is ${config.allowRegistration ? "OPEN" : "CLOSED"}`);
});
