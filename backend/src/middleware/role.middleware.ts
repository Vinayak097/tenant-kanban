import type { NextFunction, Request, Response } from "express";
import type {
  AuthenticatedUser,
  MembershipRole,
} from "./auth.middleware.js";

export type Permission =
  | "organization:manage"
  | "organization-users:manage"
  | "tenant:create"
  | "tenant:read"
  | "tenant:update"
  | "tenant:delete"
  | "tenant:assign-admin"
  | "tenant-users:manage"
  | "tenant-users:invite"
  | "tenant-users:remove"
  | "boards:view"
  | "boards:manage"
  | "columns:manage"
  | "tasks:create"
  | "tasks:update"
  | "tasks:move"
  | "tasks:manage"
  | "collaborate";

const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  ORG_ADMIN: [
    "organization:manage",
    "organization-users:manage",
    "tenant:create",
    "tenant:read",
    "tenant:update",
    "tenant:delete",
    "tenant:assign-admin",
  ],
  TENANT_ADMIN: [
    "tenant-users:manage",
    "tenant-users:invite",
    "tenant-users:remove",
    "boards:view",
    "boards:manage",
    "columns:manage",
    "tasks:manage",
    "collaborate",
  ],
  MEMBER: [
    "boards:view",
    "tasks:create",
    "tasks:update",
    "tasks:move",
    "collaborate",
  ],
};

export function hasPermission(
  role: MembershipRole,
  permission: Permission,
): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function canAccessTenant(
  user: AuthenticatedUser,
  tenant: { id: string; organizationId: string },
): boolean {
  if (user.role === "ORG_ADMIN") {
    return user.organizationId === tenant.organizationId;
  }

  return user.tenantId === tenant.id;
}

export function requireTenantAccess(
  resolveTenant: (
    request: Request,
  ) => Promise<{ id: string; organizationId: string } | null>,
) {
  return async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const user = request.user;
    if (!user) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      const tenant = await resolveTenant(request);
      if (!tenant || !canAccessTenant(user, tenant)) {
        response.status(403).json({ error: "Tenant access denied" });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requirePermission(permission: Permission) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.user) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }

    if (!hasPermission(request.user.role, permission)) {
      response.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    next();
  };
}

export function requireRole(...allowedRoles: MembershipRole[]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.user) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }

    if (!allowedRoles.includes(request.user.role)) {
      response.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    next();
  };
}
