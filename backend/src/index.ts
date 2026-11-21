import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { assertAuthConfiguration } from "./middleware/auth.middleware.js";
import { initializeSocket } from "./socket/index.js";
import { authRouter } from "./auth.routes.js";
import { apiRouter } from "./api.routes.js";

assertAuthConfiguration();

const app = express();
const server = createServer(app);

app.use(express.json());
app.use(cookieParser());
const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

app.get("/", (_request, response) => {
  response.json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api", apiRouter);

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(error);
    response.status(500).json({ error: "Internal server error" });
  },
);

initializeSocket(server);

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}

server.listen(port, () => {
  console.log(`HTTP and Socket.IO server listening on port ${port}`);
});
