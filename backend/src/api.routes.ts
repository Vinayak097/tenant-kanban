import express from "express";
import type { Request, Response } from "express";
import { prisma } from "./prisma.js";
import { authMiddleware, type AuthenticatedUser } from "./middleware/auth.middleware.js";
import { emitTenantEvent } from "./socket/index.js";

export const apiRouter = express.Router();
apiRouter.use(authMiddleware);

function param(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function stringField(value: unknown, field: string): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function forbidden(response: Response, message = "Forbidden"): void {
  response.status(403).json({ error: message });
}

async function getTenant(tenantId: string) {
  return prisma.tenant.findUnique({ where: { id: tenantId } });
}

function canAccessTenant(user: AuthenticatedUser, tenant: { id: string; organizationId: string }): boolean {
  return user.role === "ORG_ADMIN"
    ? user.organizationId === tenant.organizationId
    : user.tenantId === tenant.id;
}

function canManageOrganization(user: AuthenticatedUser, organizationId: string): boolean {
  return user.role === "ORG_ADMIN" && user.organizationId === organizationId;
}

function canManageTenant(user: AuthenticatedUser): boolean {
  return user.role === "ORG_ADMIN" || user.role === "TENANT_ADMIN";
}

async function logActivity(
  tenantId: string,
  userId: string,
  entityType: string,
  entityId: string,
  action: string,
  oldValues: object | null = null,
  newValues: object | null = null,
) {
  await prisma.activityLog.create({
    data: {
      tenantId,
      userId,
      entityType,
      entityId,
      action,
      ...(oldValues ? { oldValues } : {}),
      ...(newValues ? { newValues } : {}),
    },
  });
}

async function resolveTenantRequest(
  request: Request,
  response: Response,
  tenantIdOverride?: string,
): Promise<{ id: string; organizationId: string } | null> {
  const tenantId = tenantIdOverride ?? param(request.params.tenantId);
  if (!tenantId) {
    response.status(404).json({ error: "Tenant not found" });
    return null;
  }
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    response.status(404).json({ error: "Tenant not found" });
    return null;
  }
  if (!request.user || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return null;
  }
  return tenant;
}

/* Organizations */
apiRouter.get("/organizations", async (request, response) => {
  const user = request.user!;
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    select: { organizationId: true },
  });
  const organizationIds = [...new Set(memberships.map((membership) => membership.organizationId))];
  const organizations = await prisma.organization.findMany({
    where: { id: { in: organizationIds } },
    orderBy: { name: "asc" },
  });
  response.json({ organizations });
});

apiRouter.post("/organizations", async (request, response) => {
  const name = stringField(request.body?.name, "name");
  if (!name) {
    response.status(400).json({ error: "Organization name is required" });
    return;
  }
  const organization = await prisma.organization.create({ data: { name } });
  await prisma.membership.create({
    data: {
      userId: request.user!.id,
      organizationId: organization.id,
      role: "ORG_ADMIN",
    },
  });
  response.status(201).json({ organization });
});

apiRouter.get("/organizations/:organizationId", async (request, response) => {
  const organizationId = param(request.params.organizationId);
  if (!organizationId) {
    response.status(404).json({ error: "Organization not found" });
    return;
  }
  if (!request.user || request.user.organizationId !== organizationId) {
    forbidden(response, "Organization access denied");
    return;
  }
  const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!organization) {
    response.status(404).json({ error: "Organization not found" });
    return;
  }
  response.json({ organization });
});

apiRouter.patch("/organizations/:organizationId", async (request, response) => {
  const organizationId = param(request.params.organizationId);
  if (!organizationId || !request.user || !canManageOrganization(request.user, organizationId)) {
    forbidden(response, "Organization access denied");
    return;
  }
  const name = stringField(request.body?.name, "name");
  if (!name) {
    response.status(400).json({ error: "Organization name is required" });
    return;
  }
  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: { name },
  });
  response.json({ organization });
});

apiRouter.delete("/organizations/:organizationId", async (request, response) => {
  const organizationId = param(request.params.organizationId);
  if (!organizationId || !request.user || !canManageOrganization(request.user, organizationId)) {
    forbidden(response, "Organization access denied");
    return;
  }
  try {
    await prisma.organization.delete({ where: { id: organizationId } });
  } catch {
    response.status(409).json({ error: "Organization cannot be deleted while it contains resources" });
    return;
  }
  response.status(204).send();
});

/* Tenants */
apiRouter.get("/organizations/:organizationId/tenants", async (request, response) => {
  const organizationId = param(request.params.organizationId);
  if (!organizationId || !request.user || request.user.organizationId !== organizationId) {
    forbidden(response, "Organization access denied");
    return;
  }
  const tenants = await prisma.tenant.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
  });
  response.json({ tenants });
});

apiRouter.post("/organizations/:organizationId/tenants", async (request, response) => {
  const organizationId = param(request.params.organizationId);
  if (!organizationId || !request.user || !canManageOrganization(request.user, organizationId)) {
    forbidden(response, "Organization access denied");
    return;
  }
  const name = stringField(request.body?.name, "name");
  if (!name) {
    response.status(400).json({ error: "Tenant name is required" });
    return;
  }
  const tenant = await prisma.tenant.create({ data: { name, organizationId } });
  response.status(201).json({ tenant });
});

apiRouter.get("/tenants/:tenantId", async (request, response) => {
  const tenant = await resolveTenantRequest(request, response);
  if (tenant) response.json({ tenant });
});

apiRouter.patch("/tenants/:tenantId", async (request, response) => {
  const tenant = await resolveTenantRequest(request, response);
  if (!tenant || !request.user || !canManageOrganization(request.user, tenant.organizationId)) {
    if (tenant) forbidden(response, "Only organization admins can update tenants");
    return;
  }
  const name = stringField(request.body?.name, "name");
  if (!name) {
    response.status(400).json({ error: "Tenant name is required" });
    return;
  }
  const updated = await prisma.tenant.update({ where: { id: tenant.id }, data: { name } });
  response.json({ tenant: updated });
});

apiRouter.delete("/tenants/:tenantId", async (request, response) => {
  const tenant = await resolveTenantRequest(request, response);
  if (!tenant || !request.user || !canManageOrganization(request.user, tenant.organizationId)) {
    if (tenant) forbidden(response, "Only organization admins can delete tenants");
    return;
  }
  try {
    await prisma.tenant.delete({ where: { id: tenant.id } });
  } catch {
    response.status(409).json({ error: "Tenant cannot be deleted while it contains resources" });
    return;
  }
  response.status(204).send();
});

/* Memberships */
apiRouter.get("/tenants/:tenantId/members", async (request, response) => {
  const tenant = await resolveTenantRequest(request, response);
  if (!tenant) return;
  const members = await prisma.membership.findMany({
    where: { tenantId: tenant.id },
    include: { user: { select: { id: true, name: true, email: true, isActive: true } } },
    orderBy: { createdAt: "asc" },
  });
  response.json({ members });
});

apiRouter.post("/tenants/:tenantId/members", async (request, response) => {
  const tenant = await resolveTenantRequest(request, response);
  if (!tenant) return;
  if (!request.user || !canManageTenant(request.user)) {
    forbidden(response, "Membership management denied");
    return;
  }
  const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const role = request.body?.role;
  if (!email || !["ORG_ADMIN", "TENANT_ADMIN", "MEMBER"].includes(role)) {
    response.status(400).json({ error: "Valid email and role are required" });
    return;
  }
  if (role === "ORG_ADMIN" && request.user.role !== "ORG_ADMIN") {
    forbidden(response, "Only organization admins can assign organization admin");
    return;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    response.status(404).json({ error: "User not found" });
    return;
  }
  const existing = await prisma.membership.findFirst({
    where: {
      userId: user.id,
      organizationId: tenant.organizationId,
      tenantId: role === "ORG_ADMIN" ? null : tenant.id,
    },
  });
  const membership = existing
    ? await prisma.membership.update({
        where: { id: existing.id },
        data: { role },
      })
    : await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: tenant.organizationId,
          ...(role === "ORG_ADMIN" ? {} : { tenantId: tenant.id }),
          role,
        },
      });
  await logActivity(tenant.id, request.user.id, "membership", membership.id, "membership.added", null, { role, userId: user.id });
  response.status(201).json({ membership });
});

apiRouter.patch("/memberships/:membershipId", async (request, response) => {
  const membershipId = param(request.params.membershipId);
  if (!membershipId) {
    response.status(404).json({ error: "Membership not found" });
    return;
  }
  const membership = await prisma.membership.findUnique({
    where: { id: membershipId },
  });
  if (!membership) {
    response.status(404).json({ error: "Membership not found" });
    return;
  }
  if (!request.user || !canAccessTenant(request.user, {
    id: membership.tenantId ?? "",
    organizationId: membership.organizationId,
  }) || !canManageTenant(request.user)) {
    forbidden(response, "Membership management denied");
    return;
  }
  const role = request.body?.role;
  if (!["ORG_ADMIN", "TENANT_ADMIN", "MEMBER"].includes(role)) {
    response.status(400).json({ error: "Valid role is required" });
    return;
  }
  if (role === "ORG_ADMIN" && request.user.role !== "ORG_ADMIN") {
    forbidden(response, "Only organization admins can assign organization admin");
    return;
  }
  const updated = await prisma.membership.update({
    where: { id: membershipId },
    data: { role, tenantId: role === "ORG_ADMIN" ? null : membership.tenantId },
  });
  if (membership.tenantId) {
    await logActivity(membership.tenantId, request.user.id, "membership", membership.id, "membership.updated", { role: membership.role }, { role });
  }
  response.json({ membership: updated });
});

apiRouter.delete("/memberships/:membershipId", async (request, response) => {
  const membershipId = param(request.params.membershipId);
  const membership = membershipId
    ? await prisma.membership.findUnique({ where: { id: membershipId } })
    : null;
  if (!membership) {
    response.status(404).json({ error: "Membership not found" });
    return;
  }
  if (!request.user || !canManageTenant(request.user) ||
    (request.user.role !== "ORG_ADMIN" && request.user.tenantId !== membership.tenantId)) {
    forbidden(response, "Membership management denied");
    return;
  }
  await prisma.membership.delete({ where: { id: membershipId! } });
  if (membership.tenantId) {
    await logActivity(membership.tenantId, request.user.id, "membership", membership.id, "membership.removed", { role: membership.role }, null);
  }
  response.status(204).send();
});

/* Boards */
apiRouter.get("/tenants/:tenantId/boards", async (request, response) => {
  const tenant = await resolveTenantRequest(request, response);
  if (!tenant) return;
  const boards = await prisma.board.findMany({
    where: { tenantId: tenant.id },
    orderBy: { name: "asc" },
  });
  response.json({ boards });
});

apiRouter.post("/tenants/:tenantId/boards", async (request, response) => {
  const tenant = await resolveTenantRequest(request, response);
  if (!tenant) return;
  if (!request.user || !canManageTenant(request.user)) {
    forbidden(response, "Board management denied");
    return;
  }
  const name = stringField(request.body?.name, "name");
  if (!name) {
    response.status(400).json({ error: "Board name is required" });
    return;
  }
  const board = await prisma.$transaction(async (tx) => {
    const created = await tx.board.create({ data: { name, tenantId: tenant.id } });
    await tx.activityLog.create({
      data: { tenantId: tenant.id, userId: request.user!.id, entityType: "board", entityId: created.id, action: "board.created", newValues: { name } },
    });
    return created;
  });
  emitTenantEvent(tenant.id, "board:created", board);
  response.status(201).json({ board });
});

apiRouter.get("/boards/:boardId", async (request, response) => {
  const boardId = param(request.params.boardId);
  const board = boardId ? await prisma.board.findUnique({
    where: { id: boardId },
    include: {
      columns: {
        orderBy: { position: "asc" },
        include: { tasks: { orderBy: { position: "asc" } } },
      },
    },
  }) : null;
  if (!board) {
    response.status(404).json({ error: "Board not found" });
    return;
  }
  if (!request.user) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }
  const tenant = await getTenant(board.tenantId);
  if (!tenant || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  response.json({ board });
});

apiRouter.patch("/boards/:boardId", async (request, response) => {
  const boardId = param(request.params.boardId);
  const board = boardId ? await prisma.board.findUnique({ where: { id: boardId } }) : null;
  if (!board) {
    response.status(404).json({ error: "Board not found" });
    return;
  }
  if (!request.user || !canManageTenant(request.user)) {
    forbidden(response, "Board management denied");
    return;
  }
  const tenant = await getTenant(board.tenantId);
  if (!tenant || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  const name = stringField(request.body?.name, "name");
  if (!name) {
    response.status(400).json({ error: "Board name is required" });
    return;
  }
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.board.update({ where: { id: board.id }, data: { name } });
    await tx.activityLog.create({
      data: { tenantId: tenant.id, userId: request.user!.id, entityType: "board", entityId: board.id, action: "board.updated", oldValues: { name: board.name }, newValues: { name } },
    });
    return result;
  });
  emitTenantEvent(tenant.id, "board:updated", updated);
  response.json({ board: updated });
});

apiRouter.delete("/boards/:boardId", async (request, response) => {
  const boardId = param(request.params.boardId);
  const board = boardId ? await prisma.board.findUnique({ where: { id: boardId } }) : null;
  if (!board) {
    response.status(404).json({ error: "Board not found" });
    return;
  }
  if (!request.user || !canManageTenant(request.user)) {
    forbidden(response, "Board management denied");
    return;
  }
  const tenant = await getTenant(board.tenantId);
  if (!tenant || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.activityLog.create({
      data: { tenantId: tenant.id, userId: request.user!.id, entityType: "board", entityId: board.id, action: "board.deleted", oldValues: { name: board.name } },
    });
    await tx.board.delete({ where: { id: board.id } });
  });
  emitTenantEvent(tenant.id, "board:deleted", { boardId: board.id });
  response.status(204).send();
});

/* Columns */
apiRouter.post("/boards/:boardId/columns", async (request, response) => {
  const boardId = param(request.params.boardId);
  const board = boardId ? await prisma.board.findUnique({ where: { id: boardId } }) : null;
  if (!board) {
    response.status(404).json({ error: "Board not found" });
    return;
  }
  if (!request.user || !canManageTenant(request.user)) {
    forbidden(response, "Column management denied");
    return;
  }
  const tenant = await getTenant(board.tenantId);
  if (!tenant || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  const name = stringField(request.body?.name, "name");
  if (!name) {
    response.status(400).json({ error: "Column name is required" });
    return;
  }
  const column = await prisma.$transaction(async (tx) => {
    const count = await tx.column.count({ where: { boardId: board.id } });
    const created = await tx.column.create({
      data: { name, tenantId: tenant.id, boardId: board.id, position: count },
    });
    await tx.activityLog.create({
      data: { tenantId: tenant.id, userId: request.user!.id, entityType: "column", entityId: created.id, action: "column.created", newValues: { name, boardId: board.id, position: created.position } },
    });
    return created;
  });
  emitTenantEvent(tenant.id, "column:created", { boardId: board.id, column });
  response.status(201).json({ column });
});

apiRouter.patch("/columns/:columnId", async (request, response) => {
  const columnId = param(request.params.columnId);
  const column = columnId ? await prisma.column.findUnique({ where: { id: columnId } }) : null;
  if (!column) {
    response.status(404).json({ error: "Column not found" });
    return;
  }
  if (!request.user || !canManageTenant(request.user)) {
    forbidden(response, "Column management denied");
    return;
  }
  const tenant = await getTenant(column.tenantId);
  if (!tenant || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  const name = stringField(request.body?.name, "name");
  if (!name) {
    response.status(400).json({ error: "Column name is required" });
    return;
  }
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.column.update({ where: { id: column.id }, data: { name } });
    await tx.activityLog.create({
      data: { tenantId: tenant.id, userId: request.user!.id, entityType: "column", entityId: column.id, action: "column.updated", oldValues: { name: column.name }, newValues: { name } },
    });
    return result;
  });
  emitTenantEvent(tenant.id, "column:updated", { boardId: column.boardId, column: updated });
  response.json({ column: updated });
});

apiRouter.patch("/boards/:boardId/columns/reorder", async (request, response) => {
  const boardId = param(request.params.boardId);
  const board = boardId ? await prisma.board.findUnique({ where: { id: boardId } }) : null;
  if (!board) {
    response.status(404).json({ error: "Board not found" });
    return;
  }
  if (!request.user || !canManageTenant(request.user)) {
    forbidden(response, "Column management denied");
    return;
  }
  const tenant = await getTenant(board.tenantId);
  if (!tenant || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  if (!Array.isArray(request.body?.columnIds) ||
    !request.body.columnIds.every((id: unknown) => typeof id === "string")) {
    response.status(400).json({ error: "columnIds must be an array of IDs" });
    return;
  }
  const columnIds = request.body.columnIds as string[];
  await prisma.$transaction(async (tx) => {
    for (let position = 0; position < columnIds.length; position += 1) {
      const columnId = columnIds[position];
      if (!columnId) continue;
      await tx.column.updateMany({
        where: { id: columnId, boardId: board.id, tenantId: tenant.id },
        data: { position },
      });
    }
  });
  emitTenantEvent(tenant.id, "columns:reordered", { boardId: board.id, columnIds });
  response.json({ columnIds });
});

apiRouter.delete("/columns/:columnId", async (request, response) => {
  const columnId = param(request.params.columnId);
  const column = columnId ? await prisma.column.findUnique({ where: { id: columnId } }) : null;
  if (!column) {
    response.status(404).json({ error: "Column not found" });
    return;
  }
  if (!request.user || !canManageTenant(request.user)) {
    forbidden(response, "Column management denied");
    return;
  }
  const tenant = await getTenant(column.tenantId);
  if (!tenant || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.activityLog.create({
      data: { tenantId: tenant.id, userId: request.user!.id, entityType: "column", entityId: column.id, action: "column.deleted", oldValues: { name: column.name } },
    });
    await tx.column.delete({ where: { id: column.id } });
  });
  emitTenantEvent(tenant.id, "column:deleted", { boardId: column.boardId, columnId: column.id });
  response.status(204).send();
});

/* Tasks */
apiRouter.post("/columns/:columnId/tasks", async (request, response) => {
  const columnId = param(request.params.columnId);
  const column = columnId ? await prisma.column.findUnique({ where: { id: columnId } }) : null;
  if (!column) {
    response.status(404).json({ error: "Column not found" });
    return;
  }
  const tenant = await getTenant(column.tenantId);
  if (!tenant || !request.user || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  const title = stringField(request.body?.title, "title");
  if (!title) {
    response.status(400).json({ error: "Task title is required" });
    return;
  }
  const description = typeof request.body?.description === "string"
    ? request.body.description
    : null;
  const task = await prisma.$transaction(async (tx) => {
    const count = await tx.task.count({ where: { columnId: column.id, tenantId: tenant.id } });
    const created = await tx.task.create({
      data: { title, description, tenantId: tenant.id, columnId: column.id, position: count, version: 1 },
    });
    await tx.activityLog.create({
      data: { tenantId: tenant.id, userId: request.user!.id, entityType: "task", entityId: created.id, action: "task.created", newValues: { title, description, columnId: column.id, position: count } },
    });
    return created;
  });
  emitTenantEvent(tenant.id, "task:created", { boardId: column.boardId, task });
  response.status(201).json({ task });
});

apiRouter.get("/tasks/:taskId", async (request, response) => {
  const taskId = param(request.params.taskId);
  const task = taskId ? await prisma.task.findUnique({ where: { id: taskId } }) : null;
  if (!task) {
    response.status(404).json({ error: "Task not found" });
    return;
  }
  const tenant = await getTenant(task.tenantId);
  if (!tenant || !request.user || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  const column = await prisma.column.findUnique({ where: { id: task.columnId } });
  const logs = await prisma.activityLog.findMany({
    where: { tenantId: tenant.id, entityType: "task", entityId: task.id },
    orderBy: { createdAt: "desc" },
  });
  response.json({ task, column, activity: logs });
});

apiRouter.patch("/tasks/:taskId", async (request, response) => {
  const taskId = param(request.params.taskId);
  const task = taskId ? await prisma.task.findUnique({ where: { id: taskId } }) : null;
  if (!task) {
    response.status(404).json({ error: "Task not found" });
    return;
  }
  const tenant = await getTenant(task.tenantId);
  if (!tenant || !request.user || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  const expectedVersion = request.body?.expectedVersion;
  if (typeof expectedVersion !== "number") {
    response.status(400).json({ error: "expectedVersion is required" });
    return;
  }
  if (expectedVersion !== task.version) {
    response.status(409).json({
      error: "Task has changed",
      code: "STALE_UPDATE",
      current: task,
    });
    return;
  }
  const title = request.body?.title === undefined ? task.title : stringField(request.body.title, "title");
  if (!title) {
    response.status(400).json({ error: "Task title is required" });
    return;
  }
  const description = request.body?.description === undefined
    ? task.description
    : typeof request.body.description === "string"
      ? request.body.description
      : null;
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.task.update({
      where: { id: task.id },
      data: { title, description, version: task.version + 1 },
    });
    await tx.activityLog.create({
      data: {
        tenantId: tenant.id,
        userId: request.user!.id,
        entityType: "task",
        entityId: task.id,
        action: "task.updated",
        oldValues: { title: task.title, description: task.description, version: task.version },
        newValues: { title, description, version: task.version + 1 },
      },
    });
    return result;
  });
  const column = await prisma.column.findUnique({ where: { id: task.columnId } });
  emitTenantEvent(tenant.id, "task:updated", { boardId: column?.boardId, task: updated });
  response.json({ task: updated });
});

apiRouter.patch("/tasks/:taskId/move", async (request, response) => {
  const taskId = param(request.params.taskId);
  const task = taskId ? await prisma.task.findUnique({ where: { id: taskId } }) : null;
  if (!task) {
    response.status(404).json({ error: "Task not found" });
    return;
  }
  const tenant = await getTenant(task.tenantId);
  if (!tenant || !request.user || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  const destinationColumnId = stringField(request.body?.columnId, "columnId");
  const destinationPosition = request.body?.position;
  if (!destinationColumnId || typeof destinationPosition !== "number") {
    response.status(400).json({ error: "columnId and numeric position are required" });
    return;
  }
  const expectedVersion = request.body?.expectedVersion;
  if (typeof expectedVersion === "number" && expectedVersion !== task.version) {
    response.status(409).json({
      error: "Task has changed",
      code: "STALE_UPDATE",
      current: task,
    });
    return;
  }
  const destinationColumn = await prisma.column.findFirst({
    where: { id: destinationColumnId, tenantId: tenant.id },
  });
  if (!destinationColumn) {
    response.status(404).json({ error: "Destination column not found" });
    return;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const sourceTasks = await tx.task.findMany({
      where: { tenantId: tenant.id, columnId: task.columnId },
      orderBy: { position: "asc" },
    });
    const destinationTasks = task.columnId === destinationColumn.id
      ? sourceTasks
      : await tx.task.findMany({
          where: { tenantId: tenant.id, columnId: destinationColumn.id },
          orderBy: { position: "asc" },
        });

    const targetPosition = Math.max(0, Math.floor(destinationPosition));
    if (task.columnId === destinationColumn.id) {
      const remaining = sourceTasks.filter((item) => item.id !== task.id);
      remaining.splice(Math.min(targetPosition, remaining.length), 0, task);
      for (let position = 0; position < remaining.length; position += 1) {
        await tx.task.update({
          where: { id: remaining[position]!.id },
          data: { position, version: remaining[position]!.id === task.id ? task.version + 1 : remaining[position]!.version },
        });
      }
    } else {
      const sourceRemaining = sourceTasks.filter((item) => item.id !== task.id);
      for (let position = 0; position < sourceRemaining.length; position += 1) {
        await tx.task.update({ where: { id: sourceRemaining[position]!.id }, data: { position } });
      }
      const destinationRemaining = destinationTasks.filter((item) => item.id !== task.id);
      destinationRemaining.splice(Math.min(targetPosition, destinationRemaining.length), 0, task);
      for (let position = 0; position < destinationRemaining.length; position += 1) {
        await tx.task.update({
          where: { id: destinationRemaining[position]!.id },
          data: {
            position,
            ...(destinationRemaining[position]!.id === task.id
              ? { columnId: destinationColumn.id, version: task.version + 1 }
              : {}),
          },
        });
      }
    }

    const moved = await tx.task.findUniqueOrThrow({ where: { id: task.id } });
    await tx.activityLog.create({
      data: {
        tenantId: tenant.id,
        userId: request.user!.id,
        entityType: "task",
        entityId: task.id,
        action: "task.moved",
        oldValues: { columnId: task.columnId, position: task.position, version: task.version },
        newValues: { columnId: moved.columnId, position: moved.position, version: moved.version },
      },
    });
    return moved;
  }, { isolationLevel: "Serializable" });

  emitTenantEvent(tenant.id, "task:moved", { boardId: destinationColumn.boardId, task: updated });
  response.json({ task: updated });
});

apiRouter.delete("/tasks/:taskId", async (request, response) => {
  const taskId = param(request.params.taskId);
  const task = taskId ? await prisma.task.findUnique({ where: { id: taskId } }) : null;
  if (!task) {
    response.status(404).json({ error: "Task not found" });
    return;
  }
  const tenant = await getTenant(task.tenantId);
  if (!tenant || !request.user || !canAccessTenant(request.user, tenant)) {
    forbidden(response, "Tenant access denied");
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.activityLog.create({
      data: { tenantId: tenant.id, userId: request.user!.id, entityType: "task", entityId: task.id, action: "task.deleted", oldValues: { title: task.title, columnId: task.columnId, position: task.position } },
    });
    await tx.task.delete({ where: { id: task.id } });
    const remaining = await tx.task.findMany({
      where: { tenantId: tenant.id, columnId: task.columnId },
      orderBy: { position: "asc" },
    });
    for (let position = 0; position < remaining.length; position += 1) {
      await tx.task.update({ where: { id: remaining[position]!.id }, data: { position } });
    }
  });
  const column = await prisma.column.findUnique({ where: { id: task.columnId } });
  emitTenantEvent(tenant.id, "task:deleted", { boardId: column?.boardId, taskId: task.id, columnId: task.columnId });
  response.status(204).send();
});

apiRouter.get("/tenants/:tenantId/activity", async (request, response) => {
  const tenant = await resolveTenantRequest(request, response);
  if (!tenant) return;
  const logs = await prisma.activityLog.findMany({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  response.json({ activity: logs });
});
