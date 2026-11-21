require("dotenv/config");
const bcrypt = require("bcryptjs");

async function main() {
  if (!process.env.SEED_PASSWORD) {
    throw new Error("SEED_PASSWORD must be set before seeding test users");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  const { prisma } = require("../dist/src/prisma.js");

  const passwordHash = await bcrypt.hash(process.env.SEED_PASSWORD, 12);
  const organization = await prisma.organization.upsert({
    where: { id: "00000000-0000-4000-8000-000000000001" },
    update: { name: "Acme Organization" },
    create: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Acme Organization",
    },
  });
  const tenant = await prisma.tenant.upsert({
    where: { id: "00000000-0000-4000-8000-000000000011" },
    update: { name: "Main Branch", organizationId: organization.id },
    create: {
      id: "00000000-0000-4000-8000-000000000011",
      name: "Main Branch",
      organizationId: organization.id,
    },
  });

  async function seedUser(email, name, role, tenantId) {
    const user = await prisma.user.upsert({
      where: { email },
      update: { name, passwordHash, isActive: true },
      create: { name, email, passwordHash, isActive: true },
    });
    const existing = await prisma.membership.findFirst({
      where: {
        userId: user.id,
        organizationId: organization.id,
        ...(tenantId ? { tenantId } : { tenantId: null }),
      },
    });

    if (existing) {
      await prisma.membership.update({
        where: { id: existing.id },
        data: { role, tenantId: tenantId ?? null },
      });
    } else {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          ...(tenantId ? { tenantId } : {}),
          role,
        },
      });
    }
  }

  await seedUser("org.admin@example.com", "Vinay", "ORG_ADMIN", null);
  await seedUser("tenant.admin@example.com", "Rahul", "TENANT_ADMIN", tenant.id);
  await seedUser("customer@example.com", "John", "MEMBER", tenant.id);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
