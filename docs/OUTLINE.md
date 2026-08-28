# Outline — the docs platform

Outline is the self-hosted wiki (open source, `outlinewiki/outline`) where humans read repo
documentation. Repo docs are published into it **read-only** by a mechanical publisher — one
view-only collection per repo, every page carrying a banner naming its source file. Editing
happens in the repos; Outline's comments are the feedback channel. It replaces the board's
retired pen-documents editor.

- **URL (once deployed):** https://docs.cicadasystem.com — the `*.cicadasystem.com` wildcard
  already resolves to the Hetzner Dokploy stack; no DNS change needed.
- **Login:** staff SSO via Keycloak (`sso.cicadasystem.com`), native OIDC.
- **Compose file:** `docker-compose.outline.yml` (image pinned `outlinewiki/outline:1.9.2`).

## Deploy runbook (Dokploy)

1. **Keycloak OIDC client** — in the Keycloak admin at `sso.cicadasystem.com`, in the staff
   realm: create client `outline` (OpenID Connect, confidential/client-authentication ON),
   valid redirect URI `https://docs.cicadasystem.com/auth/oidc.callback`, web origin
   `https://docs.cicadasystem.com`. Note the client secret. The three endpoint URLs are
   `https://sso.cicadasystem.com/realms/<realm>/protocol/openid-connect/{auth,token,userinfo}`
   (realm name visible in the admin console's realm selector).
2. **Dokploy project** — create a project (e.g. `cicada-docs`) with a **Compose** service;
   paste `docker-compose.outline.yml` as raw compose (no git source needed).
3. **Environment** — in the service's Environment tab, set the compose inputs exactly:
   `OUTLINE_SECRET_KEY` and `OUTLINE_UTILS_SECRET` (32-byte hex each — `openssl rand -hex 32`),
   `OUTLINE_PG_PASSWORD` (any strong value), `OUTLINE_OIDC_CLIENT_ID=outline`,
   `OUTLINE_OIDC_CLIENT_SECRET`, `OUTLINE_OIDC_AUTH_URI`, `OUTLINE_OIDC_TOKEN_URI`, and
   `OUTLINE_OIDC_USERINFO_URI`. Set the three URI values to the endpoints from step 1.
4. **Domain** — on the `outline` service add domain `docs.cicadasystem.com` → port `3000`,
   HTTPS on (Traefik/letsencrypt). Deploy. First boot runs DB migrations (up to ~2 min).
5. **First login** — sign in via Cicada SSO; the first user becomes admin.
6. **Publisher service account** — create a dedicated Outline user (or use an admin), then
   Settings → API → new token. That token becomes `STEWARD_OUTLINE_API_TOKEN` for
   `npm run docs:publish` (and later the CI publish job). Never commit it.

## Production document export

**Before deploying board schema v25: export production pen-documents.** The v25 migration drops
their tables on first boot. From this repository's checkout on the host, run this exact command
against the `cicada-steward-3cmfas_steward-data` volume:

```bash
sudo node scripts/export-documents.mjs \
  /var/lib/docker/volumes/cicada-steward-3cmfas_steward-data/_data/private/board.sqlite \
  /root/nexus-pen-documents-v24-export
```

The destination must be absent or empty. The export writes every document as markdown plus its
full event history as JSONL. Move that directory to durable backup storage and inspect it before
rolling the new board image.

## Publish by hand

From a clean checkout with Node 24 and the default `config/docs-publish.json`:

```bash
npm ci
STEWARD_OUTLINE_API_TOKEN='<Outline API token>' npm run docs:publish
```

The command prints one JSON report per configured repo and exits nonzero if any file fails.

## Activate CI publishing

In the GitHub repository's Actions settings, create the secret `STEWARD_OUTLINE_API_TOKEN`, then
set the repository variable `DOCS_PUBLISH_ENABLED` to `true`. The publish workflow is inert until
that variable has exactly that value; once enabled, it runs after pushes to `main`.

## Known limits

- The publisher covers markdown only; relative image links inside docs will 404 in Outline
  until attachment sync exists.
- Source-absent pages are archived, never deleted — comment history survives.
- The docker-tier e2e provisions its API token by seeding Outline's database directly and is
  pinned to the image tag above; bumping the image means revisiting that seed.
