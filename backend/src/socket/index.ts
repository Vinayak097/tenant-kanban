import type { Server as HttpServer } from "node:http";
import { parseCookie } from "cookie";
import { Server } from "socket.io";
import {
  AUTH_COOKIE_NAME,
  authenticateToken,
  type AuthenticatedUser,
} from "../middleware/auth.middleware.js";
import { prisma } from "../prisma.js";

interface SocketData {
  user?: AuthenticatedUser;
}

let ioInstance: Server | null = null;

export function getIo(): Server | null {
  return ioInstance;
}

export function emitTenantEvent(
  tenantId: string,
  event: string,
  payload: unknown,
): void {
  ioInstance?.to(`tenant:${tenantId}`).emit(event, payload);
}

export function initializeSocket(httpServer: HttpServer) {
  const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim());
  const io = new Server<any, any, any, SocketData>(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
  });
  ioInstance = io;

  io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    const token = parseCookie(cookieHeader ?? "")[AUTH_COOKIE_NAME];

    if (!token) {
      next(new Error("Authentication required"));
      return;
    }

    void authenticateToken(token)
      .then((user) => {
        if (!user) {
          next(new Error("Invalid or expired authentication"));
          return;
        }

        socket.data.user = user;
        next();
      })
      .catch((error) => {
        next(error instanceof Error ? error : new Error("Authentication failed"));
      });

      io.on("connection", (socket) => {
        socket.on("tenant:join", (payload: unknown) => {
          const tenantId =
            payload && typeof payload === "object" &&
            "tenantId" in payload &&
            typeof payload.tenantId === "string"
              ? payload.tenantId
              : null;
          const user = socket.data.user;
          if (!tenantId || !user) {
            socket.emit("socket:error", { error: "Tenant room is not authorized" });
            return;
          }
          void prisma.tenant
            .findUnique({ where: { id: tenantId }, select: { id: true, organizationId: true } })
            .then((tenant) => {
              const allowed =
                tenant &&
                (user.role === "ORG_ADMIN"
                  ? user.organizationId === tenant.organizationId
                  : user.tenantId === tenant.id);
              if (!allowed) {
                socket.emit("socket:error", { error: "Tenant room is not authorized" });
                return;
              }
              void socket.join(`tenant:${tenantId}`);
            })
            .catch(() => {
              socket.emit("socket:error", { error: "Tenant room is not authorized" });
            });
        });

        socket.on("tenant:leave", (payload: unknown) => {
          const tenantId =
            payload && typeof payload === "object" &&
            "tenantId" in payload &&
            typeof payload.tenantId === "string"
              ? payload.tenantId
              : null;
          if (tenantId) void socket.leave(`tenant:${tenantId}`);
        });
      });
  });

  return io;
}
