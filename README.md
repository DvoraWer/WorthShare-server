# WorthShare Server

Backend API for **WorthShare**, a platform where users discover, search and share useful recommendations (websites, products, tips, tools). Users publish regular recommendations or, when they have a commercial relationship with the product, request **sponsored** approval with a disclosure (sponsor, product, relationship); administrators review sponsored requests and manage categories and users.

**Interactive API docs:** `http://localhost:4000/api/docs` (Swagger UI) — see [API documentation](#api-documentation).

**Live deployment:** API at `https://worthshare-api.onrender.com/api` (Render, free tier — the first request after idle can take ~30 s), Swagger UI at [`/api/docs`](https://worthshare-api.onrender.com/api/docs), database on Neon. Client: https://worth-share-client.vercel.app

## Contents

- [Technology stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Database setup](#database-setup)
- [Migrations and seed](#migrations-and-seed)
- [Running the server](#running-the-server)
- [Tests, type-check and build](#tests-type-check-and-build)
- [API documentation](#api-documentation)
- [Authentication and roles](#authentication-and-roles)
- [API overview](#api-overview)
- [Business rules](#business-rules)
- [Concurrency and data safety](#concurrency-and-data-safety)
- [Errors and responses](#errors-and-responses)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)

## Technology stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 24, TypeScript 6 (ES modules) |
| HTTP | Express 5, `cors` |
| Database | PostgreSQL (developed on 18) via Prisma 7 with the `pg` driver adapter |
| Validation | Zod 4 (bodies, query strings and path parameters) |
| Auth | JWT access tokens (`jose`, HS256), passwords hashed with bcrypt (`bcryptjs`) |
| API docs | OpenAPI 3.0.3 + Swagger UI (`swagger-ui-express`) |
| Tests | Vitest + Supertest against a dedicated PostgreSQL test database |

## Prerequisites

- **Node.js 24** — see `.nvmrc`. `package.json` declares `"engines": { "node": ">=24 <25" }`.
- **npm** (bundled with Node 24).
- **PostgreSQL** 13 or newer (the `citext` extension must be available; it ships with standard PostgreSQL packages). Developed against PostgreSQL 18.

If several Node versions are installed, run commands under Node 24 without changing your default. With [fnm](https://github.com/Schniz/fnm):

```powershell
fnm exec --using=24 -- npm.cmd install      # Windows (npm is npm.cmd)
fnm exec --using=24 -- npm install          # macOS / Linux
```

or switch the current shell with `fnm use 24` (or `nvm use`).

All commands below are run from the `server/` directory.

## Installation

```powershell
cd server
npm install              # also runs `prisma generate` (postinstall) to create the Prisma client
copy .env.example .env   # Windows;  macOS/Linux: cp .env.example .env
```

Then fill in `.env` (next section) and set up the database.

> `npm install` needs the dev dependencies: the Prisma CLI (used by `postinstall`, migrations and the seed), TypeScript (build) and `tsx` (dev server, seed). Install without `--omit=dev`, including on build/deploy machines.

## Configuration

Settings come from environment variables. `server/.env` is loaded automatically when present (real environment variables take precedence). Everything is validated at startup: the server, seed and tests refuse to run with a clear message if a value is missing or invalid. **Never commit `.env`** — it is git-ignored; `.env.example` contains placeholders only.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development`, `test` or `production`. |
| `PORT` | no | `4000` | HTTP port. |
| `CORS_ALLOWED_ORIGINS` | no | *(empty)* | Comma-separated browser origins allowed by CORS (http/https). Empty = no cross-origin browser access. |
| `DATABASE_URL` | **yes** | | `postgresql://USER:PASSWORD@HOST:5432/worthshare` |
| `JWT_SECRET` | **yes** | | Token signing secret, **at least 32 characters** of random data. |
| `JWT_EXPIRES_IN` | no | `1h` | Token lifetime: number + `s`/`m`/`h`/`d` (e.g. `15m`, `7d`). |
| `TEST_DATABASE_URL` | for tests | | A **separate** database whose name ends in `_test`. |
| `SEED_ADMIN_EMAIL` | for seeding | | Email of the initial administrator. |
| `SEED_ADMIN_PASSWORD` | for seeding | | Initial administrator password (8–72 characters). Never hardcoded. |
| `SEED_ADMIN_FULL_NAME` | no | `WorthShare Admin` | Display name of the initial administrator. |
| `SEED_DEMO_USER_PASSWORD` | for seeding | | Password shared by the seeded demo users (8–72 characters). |

Generate a JWT secret:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`.env.example` deliberately leaves `JWT_SECRET` and the seed passwords **empty**, so an unedited copy cannot run with a publicly known secret.

## Database setup

Use a **dedicated, non-superuser role** that owns both databases. As a PostgreSQL superuser (e.g. `postgres`), open `psql`:

```powershell
psql -h localhost -U postgres -d postgres
```

(On Windows `psql` is usually not on the `PATH`; use the full path, e.g. `& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -d postgres`. Use `psql` rather than pgAdmin's Query Tool here: `\password` is a `psql` command.)

and run (choose your own password when prompted; it only needs to appear in `.env`):

```sql
CREATE ROLE worthshare_app LOGIN;
\password worthshare_app
CREATE DATABASE worthshare      OWNER worthshare_app;
CREATE DATABASE worthshare_test OWNER worthshare_app;
```

Then set both URLs in `.env`:

```env
DATABASE_URL=postgresql://worthshare_app:YOUR_PASSWORD@localhost:5432/worthshare
TEST_DATABASE_URL=postgresql://worthshare_app:YOUR_PASSWORD@localhost:5432/worthshare_test
```

Characters such as `@ : / ? #` in the password must be percent-encoded in the URL.

Why this works without superuser rights: the migration installs `citext`, a *trusted* extension that a database owner may create (PostgreSQL 13+); since PostgreSQL 15 the owner also controls the `public` schema.

Check the setup (read-only — never creates anything and never prints credentials):

```powershell
npm run db:check
```

It reports, for both databases, whether the database exists, the credentials work, the role is not a superuser, it can create objects, `citext` is available, and whether migrations have been applied.

## Migrations and seed

| Command | What it does |
| --- | --- |
| `npm run db:deploy` | Apply all migrations in `prisma/migrations` (`prisma migrate deploy`). Use this for setup and deployments. |
| `npm run db:status` | Show whether the database is up to date. |
| `npm run db:seed` | Insert sample data (safe to run repeatedly). |
| `npm run db:migrate -- --name <description>` | Development only: create a new migration after editing `prisma/schema.prisma` (`prisma migrate dev`). |
| `npm run db:generate` | Regenerate the Prisma client (also runs on `npm install`). |

Notes:

- `prisma migrate deploy` **creates the target database if it does not exist** (when the role is allowed to). Run `npm run db:check` first if you want to be sure you are pointing at the intended database.
- `prisma migrate dev` needs a temporary *shadow database*, i.e. permission to create databases. The recommended `worthshare_app` role has none; for schema development either grant it (`ALTER ROLE worthshare_app CREATEDB;`) or configure a pre-created shadow database. `db:deploy`, the seed and the app never need it.
- Some constraints are written by hand in the migration SQL because Prisma cannot express them (the `citext` extension and `CHECK` constraints — see [Business rules](#business-rules)). Prisma does not track `CHECK` constraints, so later migrations will not drop them.

### Seed

`npm run db:seed` creates, **only where missing**:

- the initial administrator (from `SEED_ADMIN_*`),
- three demo users: `dana.cohen@example.com`, `yossi.levi@example.com`, `noa.mizrahi@example.com` (password `SEED_DEMO_USER_PASSWORD`),
- five active categories and one disabled category,
- six published regular recommendations (one in the disabled category), one approved sponsored recommendation, one pending sponsored request and one rejected sponsored request.

Rows are matched by email, category name, or title + author. **Existing rows are never updated, reset or deleted**; running the seed again creates nothing. If a user with `SEED_ADMIN_EMAIL` already exists it is left unchanged (a warning is printed if it is not an active admin).

## Running the server

Development (restarts on changes):

```powershell
npm run dev
```

Production:

```powershell
npm run build        # compiles src/ to dist/
npm run db:deploy    # apply any pending migrations
npm start            # node dist/server.js
```

Set `NODE_ENV=production` and provide all required variables (via the environment or `server/.env`). The server logs `WorthShare API listening on http://localhost:<PORT> (<NODE_ENV>)` and shuts down cleanly on `SIGINT`/`SIGTERM`.

Health check: `GET /api/health` → `200 { "status": "ok", "timestamp": "…" }`.

## Tests, type-check and build

| Command | Description |
| --- | --- |
| `npm test` | Run the full test suite once (Vitest). |
| `npm run test:watch` | Run tests in watch mode. |
| `npm run typecheck` | Type-check `src`, `tests`, `prisma` and `scripts` without emitting. |
| `npm run build` | Compile `src/` to `dist/`. |

Tests run against **`TEST_DATABASE_URL` only**. The database must already exist (the suite never creates one); migrations are applied to it automatically before the run, and tables are emptied between tests. Safeguards — the suite refuses to start unless:

- `TEST_DATABASE_URL` is set and its database name ends in `_test`,
- it points to a different database than `DATABASE_URL`,
- the database exists, the login works, and the role is **not** a superuser.

Each run uses a fresh random JWT secret, never the one in `.env`.

The suite covers authentication, authorization (401/403), validation, every recommendation status transition, sponsorship disclosure, sponsored review, category and user administration with their safeguards, concurrent requests (double reviews, simultaneous admin demotions), the seed, database constraints, and the OpenAPI document (see below).

## API documentation

| URL | Content |
| --- | --- |
| `http://localhost:4000/api/docs` | Swagger UI (interactive). |
| `http://localhost:4000/api/docs/openapi.json` | The OpenAPI 3.0.3 document (JSON). |

(Replace `4000` if you changed `PORT`.)

To call protected endpoints from Swagger UI: run **`POST /api/auth/login`** with the seeded admin or a demo user, copy `accessToken` from the response, click **Authorize**, paste the token and confirm. The token is remembered in that browser until you log out of the dialog or it expires.

The document is kept in `src/docs/openapi.ts`. Every success response has a realistic example (kept in `src/docs/examples.ts`); `204` responses have no body; every operation that accepts a body documents `413`. `tests/openapi.test.ts` verifies that every example matches its schema, that it is a valid OpenAPI document, that it lists **exactly** the routes registered in Express, that documented authentication/role requirements match the real 401/403 behaviour, that every status code the API returns in those checks is documented, and that real response bodies contain exactly the documented fields.

The docs are served in every environment and require no login; they describe the API's shape only and contain no data or secrets.

## Authentication and roles

1. **Register** (`POST /api/auth/register`) or **log in** (`POST /api/auth/login`). Both return:

   ```json
   {
     "accessToken": "<JWT>",
     "tokenType": "Bearer",
     "expiresIn": 3600,
     "user": { "id": 2, "fullName": "Dana Cohen", "email": "dana@example.com", "role": "User" }
   }
   ```

2. Send the token on protected requests: `Authorization: Bearer <accessToken>`.
3. `GET /api/auth/me` returns the current user.

| Role | Can |
| --- | --- |
| `User` | Browse and search; create recommendations; edit/remove **their own**; request sponsored approval for their own; see their own pending/rejected/removed items in `/mine`. |
| `Admin` | Everything a user can, plus: edit/remove **any** recommendation, review sponsored requests, manage categories, list users and change their role or active status. |

Rules:

- **Registration always creates an active `User`.** `role`, `isActive` and `id` in the body are ignored. Duplicate email (any letter case) → `409`.
- **Validation:** full name 1–100 characters; email valid, trimmed and lower-cased; password 8–72 characters (bcrypt uses at most 72 bytes, so longer passwords are rejected rather than silently truncated).
- **Generic login errors:** unknown email, wrong password and deactivated account all return `401 Invalid email or password.`; unknown emails are still checked against a dummy hash so response time does not reveal which accounts exist.
- **Tokens carry only the user id** (HS256 with issuer and audience checks). The user is **reloaded from the database on every request**, so a deactivated user's tokens stop working immediately (`401`) and role changes apply on the next request (a demoted admin gets `403` on admin endpoints). The role is never taken from the token or the request.
- Missing/invalid/expired token → `401`; authenticated but not allowed → `403`.

## API overview

Full request/response details are in Swagger UI. Lists accept `page` (≥ 1) and `pageSize` (1–50) and return `{ items, pagination: { page, pageSize, totalItems, totalPages } }`.

**Public**

| Method & path | Description |
| --- | --- |
| `GET /api/health` | Health check. |
| `POST /api/auth/register` | Create an account (always `User`). |
| `POST /api/auth/login` | Log in. |
| `GET /api/categories` | Active categories, alphabetical (default `pageSize` 50). |
| `GET /api/recommendations` | Published recommendations. Query: `search` (title + description, case-insensitive, literal, ≤ 100 chars), `categoryId`, `sortBy` = `createdAt` \| `title`, `sortOrder` = `asc` \| `desc` (default newest first / A→Z), `page`, `pageSize` (default 10). |
| `GET /api/recommendations/:id` | One published recommendation (404 for anything else). |

**Authenticated (any user)**

| Method & path | Description |
| --- | --- |
| `GET /api/auth/me` | Current user. |
| `GET /api/recommendations/mine` | The caller's recommendations in every status (same query options as the public list). |
| `POST /api/recommendations` | Create (`title` 1–120, `description` 1–3000, `categoryId` of an active category, optional http/https `url`, `imageUrl`). |
| `PUT /api/recommendations/:id` | Edit — owner or admin. Optional `publishAsRegular`. |
| `DELETE /api/recommendations/:id` | Remove (soft delete) — owner or admin. `204`. |
| `GET /api/recommendations/favorites` | The caller's favorites (public view), most recently saved first. `page`, `pageSize` (default 10). |
| `GET /api/recommendations/favorites/ids` | `{ ids }` of the caller's favorites, to mark saved items in lists. |
| `POST /api/recommendations/:id/favorite` | Save a published recommendation. `204`; saving again is a no-op; not published or unknown: `404`. |
| `DELETE /api/recommendations/:id/favorite` | Remove from favorites. `204`, also when it was not saved. |
| `POST /api/recommendations/:id/request-sponsored` | Request sponsored approval, or update the disclosure of a pending request — owner only. Body: `sponsorName` 1–120, `productName` 1–120, `sponsorshipType` (`PaidPromotion` \| `FreeProduct` \| `AffiliateLink` \| `OwnBusiness` \| `Other`), `disclosureDetails` ≤ 1000 (optional, required for `Other`). |

**Admin only** (`401` without a valid token, `403` for non-admins)

| Method & path | Description |
| --- | --- |
| `GET /api/admin/recommendations` | All users' recommendations in every status (read-only). Optional `status` = `Published` \| `PendingSponsoredApproval` \| `Rejected` \| `Removed` (omit for all), plus the public list's `search`, `categoryId`, `sortBy`, `sortOrder`, `page`, `pageSize` (default 10, newest first). |
| `GET /api/admin/recommendations/pending-sponsored` | Review queue, oldest first. |
| `PUT /api/admin/recommendations/:id/approve-sponsored` | Approve. **Required** `{ expectedUpdatedAt }`. The category must be active. |
| `PUT /api/admin/recommendations/:id/reject-sponsored` | Reject. **Required** `{ expectedUpdatedAt }`, optional `rejectionReason`. |
| `GET /api/admin/categories` | All categories, active and disabled (`search`, default `pageSize` 50). |
| `POST /api/admin/categories` | Create (`name` 1–100, optional `description` ≤ 500). `201`. |
| `PUT /api/admin/categories/:id` | Rename / change description. |
| `PATCH /api/admin/categories/:id/status` | `{ "isActive": true \| false }`. |
| `GET /api/admin/users` | Users, oldest first (`search` on name or email, default `pageSize` 10). |
| `PATCH /api/admin/users/:id/status` | `{ "isActive": true \| false }`. |
| `PATCH /api/admin/users/:id/role` | `{ "role": "User" \| "Admin" }`. |

**Response shapes.** Public recommendations: `id, title, description, url, imageUrl, isSponsored, category { id, name }, author { id, fullName }, createdAt, updatedAt` — never an email, and never the sponsorship disclosure (the public sees only the label). The owner view (`/mine`, create, edit, request-sponsored) adds `status, declaresSponsored, disclosure { sponsorName, productName, sponsorshipType, disclosureDetails } | null, reviewedAt, rejectionReason`; the admin review view adds `reviewedBy { id, fullName }`. Users (admin): `id, fullName, email, role, isActive, createdAt, updatedAt` — never the password hash.

## Business rules

### Recommendation visibility and permissions

- Public endpoints return **`Published`** recommendations only — including ones whose category was later disabled.
- Someone else's recommendation: `403` if it is public, `404` if it is private (its existence is not revealed).
- **Removing is a soft delete:** the status becomes `Removed`, the row and its audit fields are kept, it disappears from public endpoints, and the owner still sees it in `/mine`. Removed recommendations return `404` for every change.
- Author, status, sponsorship flags and reviewer are always set by the server; values sent by the client are ignored.

### Favorites

Each user has a private list of saved recommendations (one row per user and recommendation). Only published recommendations can be saved, and only published ones are listed: a saved recommendation that is later removed or sent for review disappears from the list (and from `favorites/ids`) until it is published again.

### Sponsored workflow

**"Sponsored" is a disclosure.** It means the author has a commercial relationship with the recommended product — paid to promote it, received it for free, earns through an affiliate link, owns the business, or another relationship (`Other`, which must be explained in the details) — not that anyone paid WorthShare. When requesting approval the owner states the sponsor (manufacturer or brand), the product and the relationship, plus details. **The disclosure is for the admin's decision only:** the owner and admins see it, while the public sees just the "sponsored" label.

**What admins review:** the disclosure is complete and specific, the link leads to what is described, and the content is a genuine recommendation, not misleading claims or a copied advertisement. A rejection can explain what to fix; the owner can then edit and resubmit, or publish as regular.

Two flags: `isSponsored` (admin approval, drives the sponsored label) and `declaresSponsored` (the owner's sponsorship declaration). The disclosure details are stored exactly while `declaresSponsored` is true.

| Action | From | Result |
| --- | --- | --- |
| Create | — | `Published`, not sponsored, not declared |
| Request sponsored (owner) | `Published` regular, or `Rejected` | `PendingSponsoredApproval` (private), declared with the given disclosure, previous review cleared |
| Request sponsored (owner) | `PendingSponsoredApproval` | stays pending, disclosure replaced; `updatedAt` changes, so a review of the previous version gets `409 CONFLICT` |
| Request sponsored | already approved | `409 INVALID_STATE_TRANSITION` (edit it first: that returns it to pending) |
| Request sponsored | disclosure missing or invalid | `400 VALIDATION_ERROR`; nothing changes |
| Approve (admin) | pending only, exact reviewed version, **active category** | `Published`, `isSponsored=true`, reviewer + `reviewedAt` recorded, reason cleared |
| Approve | category disabled | `409 CONFLICT`; nothing changes (the category is not re-enabled and the item is not moved or published) |
| Reject (admin) | pending only | `Rejected` (private), `isSponsored=false`, reviewer + `reviewedAt` + optional reason recorded |
| Approve / reject | anything else | `409 INVALID_STATE_TRANSITION` (removed or unknown: `404`) |
| Approve / reject | `expectedUpdatedAt` missing or invalid | `400 VALIDATION_ERROR` |
| Approve / reject | `expectedUpdatedAt` is not the current version | `409 CONFLICT` (stale review); nothing changes |
| Edit (owner or admin) | approved sponsored | back to `PendingSponsoredApproval`, approval and review cleared (unreviewed edits never appear under the sponsored label) |
| Edit | any other status | status unchanged (a rejected one stays private) |
| Edit with `publishAsRegular: true` | `Rejected` only | `Published`, not sponsored, declaration and disclosure withdrawn, review cleared (anything else: `409`) |
| Remove | any except `Removed` | `Removed` |

**Disclosure is enforced by the database** (`CHECK` constraints): a published recommendation's declaration must equal its approval, pending/rejected recommendations are always declared, approval implies declaration, a declaration always carries its sponsor, product and relationship (with no disclosure details left behind when there is no declaration), and `Other` always comes with details. A declared-sponsored recommendation therefore can only be public with the sponsored label, and a rejected one cannot become public by a status change alone.

Admins may approve their own requests; the reviewer is always recorded (logged as `selfReview`). The rejection reason is optional (≤ 1000 characters).

### Categories

- Names are **unique regardless of letter case** (PostgreSQL `citext`); duplicates → `409`.
- **Disabling** hides a category from `GET /api/categories` and from new assignments (creating or moving a recommendation into it → `400`). It never deletes the category or hides recommendations already published in it. Re-enabling restores it.
- There is **no delete endpoint**: categories are disabled, never physically deleted. Foreign keys use `RESTRICT`, so referenced categories and users cannot be deleted at the database level either.

### Users

- An admin **cannot demote or deactivate themselves** → `409`.
- The **last active admin** can never be demoted or deactivated → `409`.
- Each endpoint changes only its own field (`role` sent to `/status` is ignored, and vice versa); setting the current value is a no-op.

### Audit logging

Administrative actions are written to standard output as one JSON line each, after the change is committed (refused user-admin attempts are logged too). They contain ids, actions and outcomes — never emails, passwords, tokens or user-written text.

| Event | When |
| --- | --- |
| `recommendation.admin_action` | An admin edits or removes another user's recommendation. |
| `recommendation.sponsored_review` | A sponsored request is approved or rejected. |
| `category.admin_action` | A category is created, edited, enabled or disabled. |
| `user.admin_action` | A user's role or status change is applied, is a no-op, or is refused (with `reason`). |

## Concurrency and data safety

- **Recommendation changes** (edit, remove, request sponsored) apply only if the row is unchanged since it was read; a concurrent second change gets `409 CONFLICT` ("reload and try again").
- **Sponsored reviews** require `expectedUpdatedAt`: the `updatedAt` of the version the admin reviewed (from the pending or admin list; compared as an instant, any UTC offset). The decision is applied in one transaction by a single conditional update that matches only while the request is still pending **and** unchanged since that version, so a repeated, simultaneous or stale review gets `409` and changes nothing; if the owner edited the request in the meantime, the edit is never published under an approval it did not get.
- **Approval requires an active category.** The category row is locked (`SELECT … FOR SHARE`) inside the approval transaction: a deactivation that committed first is seen and the approval is refused with `409`; a deactivation running at the same moment waits until the approval commits (after which the category is disabled and the already-published item stays visible, as for any existing recommendation).
- **Role and status changes** run in a transaction holding a PostgreSQL advisory lock, so they are serialized. Inside it, the acting admin is re-checked (still an active admin, else `403`) and active admins are counted before applying the change. Two admins demoting or deactivating each other at the same moment can never leave the system without an active admin.
- **Unique names and emails** are enforced by database constraints, so simultaneous duplicates are refused too.
- **Search terms** are matched literally (`%` and `_` are escaped).

## Errors and responses

All errors share one shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "A clear, user-friendly error message",
    "details": [{ "path": "title", "message": "Title is required." }]
  }
}
```

`details` appears for validation errors and is omitted otherwise. Stack traces and internal details are never returned.

| Status | Code | When |
| --- | --- | --- |
| `200` / `201` / `204` | | Success (read/update, create, delete). |
| `400` | `VALIDATION_ERROR` | Invalid body, query or path parameter; malformed JSON; inactive or unknown category. |
| `413` | `VALIDATION_ERROR` | JSON request body larger than 100 KB (checked before authentication; no `details`). |
| `401` | `UNAUTHORIZED` | Missing/invalid/expired token, deactivated account, or bad login. |
| `403` | `FORBIDDEN` | Authenticated but not allowed. |
| `404` | `NOT_FOUND` | Not found, removed, or not visible to the caller; unknown route. |
| `409` | `CONFLICT` | Duplicate email/category name, admin safeguard, concurrent or stale change, approval in a disabled category. |
| `409` | `INVALID_STATE_TRANSITION` | Action not allowed in the current status. |
| `500` | `INTERNAL_ERROR` | Unexpected server error. |

## Project structure

```
server/
├── prisma/
│   ├── schema.prisma           # Data model
│   ├── migrations/             # SQL migrations (incl. hand-written constraints)
│   └── seed.ts                 # Idempotent seed
├── scripts/
│   └── check-db.ts             # Read-only database preflight (npm run db:check)
├── src/
│   ├── app.ts                  # Express app factory (used by server and tests)
│   ├── server.ts               # Entry point: starts the HTTP server
│   ├── config/                 # Zod-validated environment, CORS allowlist
│   ├── db/prisma.ts            # Prisma client (pg driver adapter)
│   ├── docs/openapi.ts         # OpenAPI document
│   ├── dto/                    # Explicit response mapping (users, recommendations, pagination)
│   ├── generated/prisma/       # Generated Prisma client (git-ignored)
│   ├── middleware/             # authenticate / requireRole, validation, error handling
│   ├── routes/                 # One router per endpoint group (incl. docs)
│   ├── services/               # Business logic, transactions and safeguards
│   ├── types/express.d.ts      # req.user typing
│   ├── utils/                  # AppError, JWT, passwords, logger, search escaping
│   └── validation/             # Zod request schemas
├── tests/                      # Vitest suites + setup (test-DB guard) and helpers
├── .env.example                # Placeholders only
├── .nvmrc                      # Node 24
├── package.json
├── prisma.config.ts            # Prisma CLI config (schema, migrations, seed, URL)
├── tsconfig.json               # Type-checking (src, tests, prisma, scripts)
├── tsconfig.build.json         # Build (src only)
└── vitest.config.ts            # Test config (uses TEST_DATABASE_URL)
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Invalid environment configuration: - JWT_SECRET: must be at least 32 characters` (or another variable) | A required variable is missing or invalid in `.env`. Fill it in; see [Configuration](#configuration). |
| `Invalid seed configuration` | Set `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` and `SEED_DEMO_USER_PASSWORD` (passwords 8–72 characters). |
| `db:check` shows `28P01` / Prisma `P1000` "Authentication failed" | Wrong user name or password in the URL (PostgreSQL reports a missing role the same way). Check `.env`; percent-encode special characters in the password. |
| `ECONNREFUSED` / Prisma `P1001` "Can't reach database server" | PostgreSQL is not running or not on the configured host/port. Start the service (Windows: `postgresql-x64-<version>` in Services). |
| `3D000` / Prisma `P1003` "Database does not exist" | Create it as shown in [Database setup](#database-setup). (`db:deploy` may create it automatically if the role is allowed to.) |
| `permission denied to create extension "citext"` | The role does not own the database, or PostgreSQL is older than 13. Make the app role the database owner (`ALTER DATABASE worthshare OWNER TO worthshare_app;`). |
| `permission denied to create database` during `npm run db:migrate` | `prisma migrate dev` needs a shadow database; see the notes in [Migrations and seed](#migrations-and-seed). Use `npm run db:deploy` to apply existing migrations. |
| Tests stop with `TEST_DATABASE_URL is not set` / `Refusing to use database …` / `Refusing to run tests with a PostgreSQL superuser role` | The test-database safeguards. Point `TEST_DATABASE_URL` at a separate, existing `*_test` database owned by a non-superuser role. |
| `Cannot find module '…/generated/prisma/client.js'` | The Prisma client was not generated (e.g. install scripts skipped). Run `npm run db:generate`. |
| `npm warn install-scripts … not yet covered by allowScripts` | npm skipped third-party install scripts (`esbuild`, Prisma engines). The tools still work; approve them with `npm install-scripts approve <package>` if you prefer. |
| `EBADENGINE` or odd runtime errors | Wrong Node version. Use Node 24 (`fnm use 24` / `nvm use`). On Windows with `fnm exec`, call `npm.cmd`, not `npm`. |
| `EADDRINUSE` | The port is taken. Stop the other process or set a different `PORT`. |
| Browser shows a CORS error | Add the client's origin (e.g. `http://localhost:5173`) to `CORS_ALLOWED_ORIGINS`. |
| `401` right after a user was deactivated, or `403` on admin endpoints after a demotion | Expected: status and role are re-read from the database on every request. |
| `409 CONFLICT` "changed by another request" / "changed after you loaded it" | A concurrent or stale update was refused to protect data. Reload and retry (for reviews, send the reloaded `updatedAt` as `expectedUpdatedAt`). |
| `409 CONFLICT` "category is disabled" when approving | Re-enable the category, reject the request, or wait for the owner to move it to an active category. |
| `400` "expectedUpdatedAt is required" on approve/reject | Send the reviewed version: `{ "expectedUpdatedAt": "<updatedAt from the list>" }`. |
| `413` on a request | The JSON body is over 100 KB. |
