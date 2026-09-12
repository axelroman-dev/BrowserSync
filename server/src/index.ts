import "express-async-errors";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { syncRouter } from "./routes/sync.js";
import { healthRouter } from "./routes/health.js";
import { authRateLimit } from "./middleware/rateLimit.js";

const app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",") }));
app.use(compression());
// A little headroom over maxBlobBytes for JSON envelope overhead (field names, base64 padding).
app.use(express.json({ limit: config.maxBlobBytes + 1024 * 64 }));

app.use("/api/health", healthRouter);
app.use("/api/auth", authRateLimit, authRouter);
app.use("/api/sync", syncRouter);

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
