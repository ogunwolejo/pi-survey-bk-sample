# Pi Surveying Backend

Backend service for the Pi Surveying platform.

## Environment Variables

Copy `.env.example` to `.env` and fill in the values. The table below covers variables that require extra setup steps.

### Notification Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HOLLY_EMAIL` | Optional | Email address of the admin (Holly) who receives new-order notifications. Leave blank to disable email notifications. |
| `VAPID_PUBLIC_KEY` | Optional | Public VAPID key for browser push notifications. |
| `VAPID_PRIVATE_KEY` | Optional | Private VAPID key — keep secret, never expose to clients. |
| `VAPID_SUBJECT` | Optional | Contact URI sent with push requests (e.g. `mailto:noreply@pisurveying.com`). |
| `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN` | Optional | Token used to verify QuickBooks webhook signatures. Leave blank to skip signature verification (not recommended in production). |

### Generating VAPID Keys

VAPID keys are needed to send browser push notifications. Generate them once per environment:

```bash
cd backend
npx web-push generate-vapid-keys
```

Copy the output into `.env`:

```env
VAPID_PUBLIC_KEY="BNcR..."    # long base64 string
VAPID_PRIVATE_KEY="aB9x..."   # keep this secret
VAPID_SUBJECT="mailto:noreply@pisurveying.com"
```

> **Note:** Generate separate key pairs for each environment (local, staging, production). Never reuse production keys in local or staging.

### QuickBooks Webhook Verifier Token

This token allows the backend to verify that incoming webhook calls genuinely originate from QuickBooks, preventing spoofed requests from creating fake orders.

1. Log in to the [QuickBooks Developer Dashboard](https://developer.intuit.com)
2. Open your app → **Webhooks**
3. Copy the **Verifier Token** shown on that page
4. Paste it into `.env`:

```env
QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN="your-verifier-token"
```

If this variable is left blank, webhook signature verification is skipped and a warning is logged. This is acceptable for local development but should be set in staging and production.

---

## Seeded Employee Accounts

After running `npx prisma db seed`, the following employee accounts are available for login:

| Role | Email | Password | Team | Platform Access |
| ---- | ----- | -------- | ---- | --------------- |
| Admin | `admin@pisurveying.com` | `Password123!` | Both | Both (web + mobile) |
| Office Manager | `officemanager@pisurveying.com` | `Password123!` | Residential | Web only |

The existing **Super Admin** account (`superadmin@pisurveying.com` or the value of `SEED_ADMIN_EMAIL`) is also created but does not have a credential account by default — use the invite flow or set one up manually.

### Overriding the default password

Set `SEED_EMPLOYEE_PASSWORD` in your `.env` to use a custom password for all seeded employees:

```
SEED_EMPLOYEE_PASSWORD=MyCustomPass123
```

### Production safety

Employee accounts are **not** seeded when `NODE_ENV=production` unless you explicitly set `SEED_EMPLOYEES=true`.
