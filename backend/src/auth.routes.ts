import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import express from "express";
import jwt from "jsonwebtoken";
import { prisma } from "./prisma.js";
import {
  AUTH_COOKIE_NAME,
  authMiddleware,
  verifyToken,
} from "./middleware/auth.middleware.js";

export const authRouter = express.Router();

function getCookieOptions() {
  const secure =
    process.env.COOKIE_SECURE === "true" ||
    process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };
}

function publicUserResponse(user: {
  id: string;
  name: string;
  email: string;
  membershipId: string;
  organizationId: string;
  role: "ORG_ADMIN" | "TENANT_ADMIN" | "MEMBER";
  tenantId?: string;
}) {
  return {
    id: user.id,
    username: user.name,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    tenantId: user.tenantId ?? null,
  };
}

authRouter.post("/login", async (request: Request, response: Response) => {
  const identifier =
    typeof request.body?.identifier === "string"
      ? request.body.identifier.trim()
      : "";
  const password =
    typeof request.body?.password === "string" ? request.body.password : "";
  const membershipId =
    typeof request.body?.membershipId === "string"
      ? request.body.membershipId
      : undefined;

  if (!identifier || !password) {
    response.status(400).json({ error: "Email/username and password are required" });
    return;
  }

  const normalizedIdentifier = identifier.toLowerCase();
  const user = await prisma.user.findFirst({
    where: identifier.includes("@")
      ? { email: normalizedIdentifier }
      : { name: identifier },
  });

  if (
    !user ||
    !user.isActive ||
    !(await bcrypt.compare(password, user.passwordHash))
  ) {
    response.status(401).json({ error: "Invalid email/username or password" });
    return;
  }

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: {
      organization: { select: { id: true, name: true } },
      tenant: { select: { id: true, name: true } },
    },
  });

  if (memberships.length === 0) {
    response.status(403).json({ error: "No authorized membership" });
    return;
  }

  let membership = membershipId
    ? memberships.find((candidate) => candidate.id === membershipId)
    : memberships.length === 1
      ? memberships[0]
      : undefined;

  if (membershipId && !membership) {
    response.status(403).json({ error: "Unauthorized membership" });
    return;
  }

  if (!membership) {
    response.status(409).json({
      error: "Select a membership",
      memberships: memberships.map((candidate) => ({
        id: candidate.id,
        role: candidate.role,
        organization: candidate.organization,
        tenant: candidate.tenant,
      })),
    });
    return;
  }

  if (
    membership.role !== "ORG_ADMIN" &&
    !membership.tenantId
  ) {
    response.status(403).json({ error: "No tenant authorized for this membership" });
    return;
  }

  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      membershipId: membership.id,
      expiresAt,
    },
  });

  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET must be set");
  const token = jwt.sign({}, secret, {
    subject: user.id,
    jwtid: session.id,
    expiresIn: "8h",
  });

  response.cookie(AUTH_COOKIE_NAME, token, {
    ...getCookieOptions(),
    maxAge: 8 * 60 * 60 * 1000,
  });

  const authenticated = {
    id: user.id,
    name: user.name,
    email: user.email,
    membershipId: membership.id,
    organizationId: membership.organizationId,
    role: membership.role,
    ...(membership.tenantId ? { tenantId: membership.tenantId } : {}),
  };
  response.json({ user: publicUserResponse(authenticated) });
});

authRouter.get("/me", authMiddleware, (request: Request, response: Response) => {
  if (!request.user) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }
  response.json({ user: publicUserResponse(request.user) });
});

authRouter.post("/logout", async (request: Request, response: Response) => {
  const token: unknown = request.cookies?.[AUTH_COOKIE_NAME];
  if (typeof token === "string") {
    const verified = verifyToken(token);
    if (verified) {
      await prisma.session.updateMany({
        where: {
          id: verified.sessionId,
          userId: verified.userId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    }
  }

  response.clearCookie(AUTH_COOKIE_NAME, getCookieOptions());
  response.status(204).send();
});
