import "dotenv/config";
import cookieParser from "cookie-parser";
import express from "express";
import { createServer } from "node:http";
import { assertAuthConfiguration } from "./middleware/auth.middleware.js";
import { initializeSocket } from "./socket/index.js";

assertAuthConfiguration();

const app = express();
const server = createServer(app);

app.use(express.json());
app.use(cookieParser());

app.get("/", (_request, response) => {
  response.json({ status: "ok" });
});

initializeSocket(server);

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}

server.listen(port, () => {
  console.log(`HTTP and Socket.IO server listening on port ${port}`);
});
