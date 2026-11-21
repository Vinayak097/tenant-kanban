import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma.js";

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
      name: string;
      email: string;
      membershipId: string;
      organizationId: string;
      role: "ORG_ADMIN";
      tenantId?: string;
    }
  | {
      id: string;
      name: string;
      email: string;
      membershipId: string;
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

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET must be set to authenticate requests");
  }
  return secret;
}

export function assertAuthConfiguration(): void {
  getJwtSecret();
}

export function verifyToken(token: string): { userId: string; sessionId: string } | null {
  const secret = getJwtSecret();
  try {
    const payload = jwt.verify(token, secret);
    if (
      typeof payload === "string" ||
      typeof payload.sub !== "string" ||
      typeof payload.jti !== "string"
    ) {
      return null;
    }
    return { userId: payload.sub, sessionId: payload.jti };
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      return null;
    }
    throw error;
  }
}

export async function authenticateToken(
  token: string,
): Promise<AuthenticatedUser | null> {
  const verified = verifyToken(token);
  if (!verified) return null;

  const session = await prisma.session.findUnique({
    where: { id: verified.sessionId },
    include: {
      user: true,
      membership: true,
    },
  });

  if (
    !session ||
    session.userId !== verified.userId ||
    session.revokedAt ||
    session.expiresAt <= new Date() ||
    !session.user.isActive
  ) {
    return null;
  }

  const membership = session.membership;
  if (!isMembershipRole(membership.role)) return null;

  if (membership.role === "ORG_ADMIN") {
    return {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      membershipId: membership.id,
      organizationId: membership.organizationId,
      role: "ORG_ADMIN",
      ...(membership.tenantId ? { tenantId: membership.tenantId } : {}),
    };
  }

  if (!membership.tenantId) return null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    membershipId: membership.id,
    organizationId: membership.organizationId,
    role: membership.role,
    tenantId: membership.tenantId,
  };
}

export async function authMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const token: unknown = request.cookies?.[AUTH_COOKIE_NAME];
  if (typeof token !== "string") {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const user = await authenticateToken(token);
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
