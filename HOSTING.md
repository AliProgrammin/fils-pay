# Hosting FilsPay

This guide puts the whole app on one machine with Docker. One web address
serves everything:

| Path | What |
|---|---|
| `/` | Merchant dashboard and checkout (apps/web). Login at `/dashboard/login`. |
| `/admin/` | Admin console (apps/admin) |
| `/v1/...` | The API |
| `/healthz`, `/readyz` | Health checks |

Files: `ops/docker-compose.prod.yml` (the stack), `ops/Dockerfile.web`
(nginx with both front ends), `ops/nginx/filspay.conf`,
`ops/.env.production.example` (settings), `scripts/smoke_hosted.sh` (test).

Only the web container publishes a port. Postgres, the API and the
settlement service are not reachable from outside.

You need Docker with Docker Compose v2, plus `curl` and `jq` for the test.

## 1. Create the settings file

```sh
cp ops/.env.production.example ops/.env.production
```

Open `ops/.env.production` and replace each `CHANGE_ME`. Each line has the
command that makes a strong value:

```sh
openssl rand -hex 24      # POSTGRES_PASSWORD (use it in DATABASE_URL too)
openssl rand -hex 32      # SETTLEMENT_INTERNAL_TOKEN
openssl rand -hex 32      # ACQUIRER_CALLBACK_SIGNING_SECRET
openssl rand -base64 32   # WEBHOOK_SECRET_ENCRYPTION_KEY
```

Set `CHECKOUT_BASE_URL` to the public address. The file is gitignored.
Never commit it. Do not use `ops/.env.docker`: it is a dev file.

## 2. Run it on your own machine (production mode)

In `ops/.env.production`, set `COOKIE_SECURE=false` (plain http only) and
`CHECKOUT_BASE_URL=http://localhost:8088`. Then:

```sh
FILSPAY_HTTP_PORT=8088 docker compose -f ops/docker-compose.prod.yml -p filspay-prod up -d --build
```

Open http://localhost:8088. The `-p filspay-prod` name keeps it apart from
the dev stack (`ops/docker-compose.yml`). Stop and delete it, data included:

```sh
docker compose -f ops/docker-compose.prod.yml -p filspay-prod down -v
```

## 3. Deploy to a server (VM or container host with Docker)

1. Copy the repo to the server (`git clone`, or `rsync`/`scp` the folder).
2. Create `ops/.env.production` on the server (step 1).
   - Behind HTTPS: keep `COOKIE_SECURE=true`.
   - Plain http only (no TLS yet): set `COOKIE_SECURE=false`, or login will
     not stick.
3. From the repo root:

   ```sh
   docker compose -f ops/docker-compose.prod.yml up -d --build
   ```

   The site listens on port 80. Change it with `FILSPAY_HTTP_PORT=8080`
   in front of the command.
4. Open `http://<server-address>/` (or your domain). Open port 80 (or your
   port) in the server's firewall.

The first start runs the database migrations and loads the demo data. Later
starts run new migrations only; the demo data is not loaded again, so what
people do in the demo stays.

Useful commands:

```sh
docker compose -f ops/docker-compose.prod.yml ps          # status
docker compose -f ops/docker-compose.prod.yml logs -f api # API logs
docker compose -f ops/docker-compose.prod.yml up -d --build   # update after git pull
```

**HTTPS.** The web container speaks plain http on port 80. Put TLS in front
of it: the host's load balancer or a reverse proxy (Caddy, nginx, Traefik)
that forwards to the web port. Then set `COOKIE_SECURE=true` and use the
https address in `CHECKOUT_BASE_URL`.

## 4. Smoke test

```sh
BASE_URL=http://localhost:8088 scripts/smoke_hosted.sh
```

It checks health, the two front ends, admin login, merchant login, the
transaction list, and a full API flow: API key, authorize 10.000 BD,
capture, partial refund of 4.000 BD. Each check prints `PASS` or `FAIL`; the
last line is `RESULT: ALL PASS` on success. It needs `OTP_DEV_EXPOSE=true`
on the server (and `COOKIE_SECURE=false` when `BASE_URL` is plain http).
It changes demo data: it turns refunds on for Alpha Retail Co and adds one
payment and one refund.

## 5. Demo logins

All accounts are demo data from `db/seed/generate.ts`.

**OTP.** There is no real email or SMS delivery. With `OTP_DEV_EXPOSE=true`
the login page shows the one-time code on screen ("Development code"). This
is a demo-only setting.

**Admin console** (`/admin/`), password `FilsPayAdminSeed!2026`:

| Email | Role |
|---|---|
| `superadmin@filspay.test` | super_admin |
| `finance@filspay.test` | finance (can turn refunds on per merchant) |
| `support@filspay.test` | support |

**Merchant dashboard** (`/dashboard/login`), password `FilsPaySeed!2026`.
The login form asks for the merchant ID:

| Merchant | Merchant ID | Owner email |
|---|---|---|
| Alpha Retail Co | `9972daab-2c86-459f-9d78-3fe1be4e3280` | `owner@alpharetail.example` (also `finance@alpharetail.example`) |
| Beta Digital Services | `3a1a204a-4b91-4739-b955-45e95e2e2e34` | `owner@betadigital.example` |
| Coral Bay Traders | `fb338e02-053f-4915-85c5-846b9a76ba79` | `owner@coralbaytraders.example` |
| Delta Wholesale Traders | `ce668d19-d805-469d-bc7e-d3b1741a6f16` | `owner@deltawholesale.example` |

The seed makes the same IDs each time. The admin console's merchant list
shows all of them.

**Refunds** start off for each merchant. To demo them: sign in to the admin
console as `finance@filspay.test`, open the merchant, turn refunds on. Then
refund a captured payment from the merchant dashboard or the API (see
`scripts/smoke_hosted.sh` for the API calls).

## 6. Before a real launch (not the demo)

- **OTP delivery.** Add a real email or SMS sender in
  `apps/api/src/auth/notifier.ts` and `apps/api/src/adminAuth/notifier.ts`
  (today they only log). Then set `OTP_DEV_EXPOSE=false`.
- **TLS.** Serve only over HTTPS, keep `COOKIE_SECURE=true`.
- **No demo data.** Remove the `seed` service from
  `ops/docker-compose.prod.yml` and the seeded users. The seeded passwords
  are public in this repo.
- **Separate database roles.** Today every service uses the one `filspay`
  role, which owns the database. Give the api, settlement, reporting and
  migrations their own roles with only the grants they need.
- **Managed Postgres and backups.** Use a managed database (with TLS,
  `sslmode=require`) or at least back up the `pgdata` volume. KYC uploads
  live in the `kyc` volume; back it up too.
- **Secrets.** Keep them in the host's secret store, not a file on disk.
  Do not change `WEBHOOK_SECRET_ENCRYPTION_KEY` once in use.
- **Real acquirer.** The acquirer is simulated; connect the real one and its
  real `ACQUIRER_CALLBACK_SIGNING_SECRET`.
