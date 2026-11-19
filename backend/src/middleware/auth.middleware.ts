import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export const AUTH_COOKIE_NAME = "auth_token";

export const MEMBERSHIP_ROLES = [
  "ORG_ADMIN",
  "TENANT_ADMIN",
  "MEMBER",
] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export type AuthenticatedUser =
  | {
      id: string;
      organizationId: string;
      role: "ORG_ADMIN";
      tenantId?: string;
    }
  | {
      id: string;
      organizationId: string;
      role: "TENANT_ADMIN" | "MEMBER";
      tenantId: string;
    };

function isMembershipRole(role: unknown): role is MembershipRole {
  return (
    typeof role === "string" &&
    MEMBERSHIP_ROLES.some((membershipRole) => membershipRole === role)
  );
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET must be set to authenticate requests");
  }
  return secret;
}

export function assertAuthConfiguration(): void {
  getJwtSecret();
}

export function authenticateToken(token: string): AuthenticatedUser | null {
  const secret = getJwtSecret();

  try {
    const payload = jwt.verify(token, secret);
    if (
      typeof payload === "string" ||
      typeof payload.sub !== "string" ||
      typeof payload.organizationId !== "string" ||
      !isMembershipRole(payload.role)
    ) {
      return null;
    }

    if (payload.role === "ORG_ADMIN") {
      const user: AuthenticatedUser = {
        id: payload.sub,
        organizationId: payload.organizationId,
        role: payload.role,
      };
      if (typeof payload.tenantId === "string") {
        user.tenantId = payload.tenantId;
      }
      return user;
    }

    if (typeof payload.tenantId !== "string") {
      return null;
    }

    return {
      id: payload.sub,
      organizationId: payload.organizationId,
      role: payload.role,
      tenantId: payload.tenantId,
    };
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      return null;
    }
    throw error;
  }
}

export function authMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const token: unknown = request.cookies?.[AUTH_COOKIE_NAME];
  if (typeof token !== "string") {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const user = authenticateToken(token);
    if (!user) {
      response.status(401).json({ error: "Invalid or expired authentication" });
      return;
    }

    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
