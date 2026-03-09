/**
 * Extracted seed logic — importable from both the container entrypoint
 * (compiled dist/seed.js) and the local-dev prisma/seed.ts wrapper (via tsx).
 */
import { PrismaClient, UserRole, UserTeam, PlatformAccess } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { seedLog } from "./lib/deploy-logger";

const BCRYPT_ROUNDS = 12;

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const { DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME } = process.env;
  if (DB_HOST && DB_PORT && DB_USERNAME && DB_PASSWORD && DB_NAME) {
    return `postgresql://${DB_USERNAME}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
  }

  throw new Error("DATABASE_URL or DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_NAME must be set");
}

export async function runSeed(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: getDatabaseUrl() });
  const prisma = new PrismaClient({ adapter });

  try {
    // US Federal holidays 2026
    const holidays = [
      { date: new Date("2026-01-01"), name: "New Year's Day", recurring: true },
      { date: new Date("2026-01-19"), name: "Martin Luther King Jr. Day", recurring: false },
      { date: new Date("2026-02-16"), name: "Presidents' Day", recurring: false },
      { date: new Date("2026-05-25"), name: "Memorial Day", recurring: false },
      { date: new Date("2026-07-04"), name: "Independence Day", recurring: true },
      { date: new Date("2026-09-07"), name: "Labor Day", recurring: false },
      { date: new Date("2026-11-11"), name: "Veterans Day", recurring: true },
      { date: new Date("2026-11-26"), name: "Thanksgiving Day", recurring: false },
      { date: new Date("2026-12-25"), name: "Christmas Day", recurring: true },
    ];

    for (const h of holidays) {
      await prisma.holiday.upsert({
        where: { date: h.date },
        create: h,
        update: { name: h.name, recurring: h.recurring },
      });
    }
    seedLog(`Upserted ${holidays.length} holidays`);

    // System settings
    const settings = [
      { key: "base_survey_price", value: 495, description: "Default survey base price ($)" },
      {
        key: "county_pricing",
        value: {
          cook: 595, dupage: 595, lake: 595,
          will: 495, kane: 495, mchenry: 495, kendall: 495,
          dekalb: 495, kankakee: 495, iroquois: 495, lasalle: 495, grundy: 495,
        },
        description: "Base survey price by county ($)",
      },
      { key: "rush_fee", value: 100, description: "Rush order surcharge ($)" },
      { key: "quote_expiry_days", value: 30, description: "Days until a quote expires" },
      {
        key: "company_return_address",
        value: {
          line1: "Pi Surveying",
          line2: "123 Main St",
          city: "Austin",
          state: "TX",
          zip: "78701",
        },
        description: "Company address for return labels",
      },
      {
        key: "label_dimensions",
        value: { width: 4, height: 6, unit: "in" },
        description: "Shipping label dimensions",
      },
      { key: "auto_create_companies", value: true, description: "Auto-create company records from email domains" },
    ];

    for (const s of settings) {
      await prisma.systemSetting.upsert({
        where: { key: s.key },
        create: { key: s.key, value: s.value, description: s.description },
        update: { value: s.value, description: s.description },
      });
    }
    seedLog(`Upserted ${settings.length} system settings`);

    // Super admin user
    const superAdminEmail = process.env.SEED_ADMIN_EMAIL ?? "superadmin@pisurveying.com";
    const existingSuperAdmin = await prisma.user.findUnique({ where: { email: superAdminEmail } });
    if (!existingSuperAdmin) {
      await prisma.user.create({
        data: {
          name: "Super Admin",
          email: superAdminEmail,
          role: UserRole.super_admin,
          platformAccess: PlatformAccess.both,
          team: UserTeam.both,
          isActive: true,
        },
      });
      seedLog(`Created super admin: ${superAdminEmail}`);
    }

    // Employee accounts (admin + office_manager + crew roles)
    const isProduction = process.env.NODE_ENV === "production";
    const seedEmployees = process.env.SEED_EMPLOYEES === "true";

    if (!isProduction || seedEmployees) {
      const password = process.env.SEED_EMPLOYEE_PASSWORD ?? "Password123!";
      const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const employees = [
        {
          name: "Admin User",
          email: "admin@pisurveying.com",
          role: UserRole.admin,
          platformAccess: PlatformAccess.both,
          team: UserTeam.both,
        },
        {
          name: "Office Manager",
          email: "officemanager@pisurveying.com",
          role: UserRole.office_manager,
          platformAccess: PlatformAccess.web,
          team: UserTeam.residential,
        },
        {
          name: "Holly Mitchell",
          email: "holly@pisurveying.com",
          role: UserRole.office_manager,
          platformAccess: PlatformAccess.both,
          team: UserTeam.residential,
        },
        {
          name: "Alex Thompson",
          email: "alex@pisurveying.com",
          role: UserRole.admin,
          platformAccess: PlatformAccess.both,
          team: UserTeam.both,
        },
        {
          name: "Abinash Patel",
          email: "abinash@pisurveying.com",
          role: UserRole.pls_reviewer,
          platformAccess: PlatformAccess.both,
          team: UserTeam.both,
        },
        {
          name: "Connor Walsh",
          email: "connor@pisurveying.com",
          role: UserRole.crew_manager,
          platformAccess: PlatformAccess.both,
          team: UserTeam.both,
        },
      ];

      for (const emp of employees) {
        const existing = await prisma.user.findUnique({ where: { email: emp.email } });

        if (!existing) {
          const user = await prisma.user.create({
            data: {
              name: emp.name,
              email: emp.email,
              role: emp.role,
              platformAccess: emp.platformAccess,
              team: emp.team,
              isActive: true,
              emailVerified: true,
            },
          });

          await prisma.account.create({
            data: {
              accountId: user.id,
              providerId: "credential",
              userId: user.id,
              password: hashedPassword,
            },
          });

          seedLog(`Created employee: ${emp.email} (${emp.role})`);
        } else {
          const account = await prisma.account.findFirst({
            where: { userId: existing.id, providerId: "credential" },
          });
          if (!account) {
            await prisma.account.create({
              data: {
                accountId: existing.id,
                providerId: "credential",
                userId: existing.id,
                password: hashedPassword,
              },
            });
            seedLog(`Created missing credential account for: ${emp.email}`);
          }
        }
      }
    } else {
      seedLog("Skipping employee seed (NODE_ENV=production without SEED_EMPLOYEES=true)");
    }
  } finally {
    await prisma.$disconnect();
  }
}
