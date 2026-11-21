const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hasPermission,
  canAccessTenant,
} = require("../dist/middleware/role.middleware.js");

test("customer cannot access admin permissions", () => {
  assert.equal(hasPermission("MEMBER", "tenant-users:manage"), false);
  assert.equal(hasPermission("MEMBER", "organization:manage"), false);
});

test("tenant admin is limited to an assigned tenant", () => {
  const tenantAdmin = {
    id: "admin",
    organizationId: "org-a",
    role: "TENANT_ADMIN",
    tenantId: "tenant-a",
  };
  assert.equal(
    canAccessTenant(tenantAdmin, { id: "tenant-a", organizationId: "org-a" }),
    true,
  );
  assert.equal(
    canAccessTenant(tenantAdmin, { id: "tenant-b", organizationId: "org-a" }),
    false,
  );
});

test("organization admin is limited to its organization", () => {
  const orgAdmin = {
    id: "admin",
    organizationId: "org-a",
    role: "ORG_ADMIN",
  };
  assert.equal(
    canAccessTenant(orgAdmin, { id: "tenant-a", organizationId: "org-a" }),
    true,
  );
  assert.equal(
    canAccessTenant(orgAdmin, { id: "tenant-b", organizationId: "org-b" }),
    false,
  );
});
