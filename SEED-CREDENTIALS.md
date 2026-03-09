# Pi Surveying — Seed User Credentials

These credentials are created by the seed script (`prisma/seed.ts`) for **local**, **development**, and **staging** environments.

> **Do NOT use these in production.** Production users should be onboarded via the invitation flow.

## Default Password

All seeded users share the same password unless overridden by the `SEED_EMPLOYEE_PASSWORD` environment variable.

| Default Password |
|------------------|
| `Password123!`   |

## Seeded Users

| Name             | Email                          | Role            | Platform Access | Team        |
|------------------|--------------------------------|-----------------|-----------------|-------------|
| Holly Mitchell   | `holly@pisurveying.com`        | office_manager  | both          | residential |
| Alex Thompson    | `alex@pisurveying.com`         | admin           | both            | both        |
| Abinash Patel    | `abinash@pisurveying.com`      | pls_reviewer    | both            | both        |
| Connor Walsh     | `connor@pisurveying.com`       | crew_manager    | both            | both        |

## Role Descriptions

| Role           | Description                                        |
|----------------|----------------------------------------------------|
| super_admin    | Full system access, platform configuration         |
| admin          | Company owner / admin — full portal access          |
| office_manager | Manages quotes, orders, and office operations      |
| pls_reviewer   | Professional Land Surveyor — reviews research/data |
| crew_manager   | Manages field crews and crew assignments           |

## Notes

- **Super Admin** does not have a password credential — access is via magic link or OTP only.
- **Holly** is configured for **mobile-only** access (the mobile app).
- **Alex** is the admin owner of the company.
- **Abinash** is the head of the research team (`pls_reviewer` role).
- **Connor** is the crew manager.
- The seed script uses `upsert` logic — re-running it will not duplicate users but will create missing credential accounts.
