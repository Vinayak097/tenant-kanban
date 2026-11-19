import type { Server as HttpServer } from "node:http";
import { parseCookie } from "cookie";
import { Server } from "socket.io";
import {
  AUTH_COOKIE_NAME,
  authenticateToken,
  type AuthenticatedUser,
} from "../middleware/auth.middleware.js";

interface SocketData {
  user?: AuthenticatedUser;
}

export function initializeSocket(httpServer: HttpServer) {
  const io = new Server<never, never, never, SocketData>(httpServer);

  io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    const token = parseCookie(cookieHeader ?? "")[AUTH_COOKIE_NAME];

    if (!token) {
      next(new Error("Authentication required"));
      return;
    }

    try {
      const user = authenticateToken(token);
      if (!user) {
        next(new Error("Invalid or expired authentication"));
        return;
      }

      socket.data.user = user;
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error("Authentication failed"));
    }
  });

  return io;
}
