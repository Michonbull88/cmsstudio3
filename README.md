# Studio CMS

A connected content workspace with a Node.js backend, SQLite database, owner authentication, media storage, and server-side publishing. The existing dashboard, editor, calendar, media library, and settings use the backend directly.

## Test on GitHub

### Automated tests

[Open the test runs](https://github.com/Michonbull88/cmsstudio3/actions/workflows/test.yml).
GitHub Actions runs the backend and Chromium browser tests on every push and pull request. You can also select **Run workflow** in the Actions tab. Test databases are temporary; no real workspace data or secrets are required.

### Run a browser preview with Codespaces

1. [Create a Codespace for this repository](https://codespaces.new/Michonbull88/cmsstudio3) using the `main` branch. Existing Codespaces need **Codespaces: Rebuild Container** after pulling this configuration.
2. Wait for the container and dependencies to finish installing.
3. In the Codespaces terminal, run `npm run preview`.
4. On first use, enter your name, email, and a new password in that terminal. Password input is hidden. Later starts reuse the same account.
5. Open **Ports**, find **3000 — Studio CMS preview**, and click **Open in Browser**. Sign in with the account you just created.

Keep port 3000's visibility **Private**. The preview URL is detected automatically; use its HTTPS browser address. The internal port protocol stays HTTP because the forwarding service provides external HTTPS. The preview works while the Codespace and server are running. Stop the Codespace after testing; GitHub account usage limits and billing apply.

The preview database lives in that Codespace's ignored `data/` folder. It is separate from your computer's database and is not pushed to GitHub. Export a backup before deleting the Codespace. To run browser tests inside Codespaces, first run `npx playwright install --with-deps chromium`, then `npm run test:browser`.

If using `npm start` directly on a fresh Codespace, first run `npm run setup-owner`: browser-based account creation intentionally stays restricted to direct local connections. `npm run preview` handles this setup for you. Forgot the preview password? Run `npm run reset-password` in its terminal.

References: [GitHub port forwarding](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace), [Codespaces environment](https://docs.github.com/en/codespaces/developing-in-a-codespace/default-environment-variables-for-your-codespace).

## If the backend will not connect

- **Address ends in `github.io/cmsstudio3/`:** this is GitHub Pages, which serves static files. Open your Codespace from [your Codespaces list](https://github.com/codespaces), run `git pull` followed by `npm run preview`, then open port **3000** from **Ports**. The connected preview address ends in `-3000.app.github.dev`.
- **Preview was working and stopped:** restart the Codespace and rerun `npm run preview`. Leave the terminal running. The preview is not an always-on hosted service.
- **Terminal shows an error:** copy that error and the URL you opened when requesting help. Do not include passwords. If Node is older than 24.14, rebuild the dev container.
- **Preview shows “Use the configured workspace address”:** use the exact HTTPS address printed by the server. If you previously set `APP_ORIGIN`, remove that override from the preview terminal with `unset APP_ORIGIN` before restarting.

## Start

Requires **Node.js 24.14 or newer**.

```sh
cd Studio-CMS
npm start
```

Open **http://localhost:3000** and create your owner account. Choose your own email and a password of at least 12 characters. There are no default credentials. Initial account creation is allowed only through a direct local connection, and closes once an owner exists.

The application has no runtime npm dependencies. `npm install` installs the browser test tooling; it is optional for running the server. Node may print a warning for its built-in SQLite module on Node 24.

Use the Node server instead of `python3 -m http.server`. The server serves both the interface and API. The database is created automatically at `data/studio.sqlite`; it survives browser clearing and server restarts.

## What is connected

- Owner setup, sign-in, sign-out, password changes, and local password recovery
- Salted scrypt password hashes and seven-day HttpOnly, SameSite session cookies
- SQLite storage for articles, pages, newsletters, images, settings, activity, and sessions
- Validated, transactional saves with revision checks that reject stale updates
- Media uploads: PNG, JPEG, GIF, WebP, AVIF; 1 MB per image and 12 MB total
- Server-generated activity history; clients cannot forge the stored audit log
- Scheduling every 10 seconds while the server is running; overdue entries publish when it restarts
- Public stories at **http://localhost:3000/site** and published-only JSON at `/api/public/content`
- Protected database content backup export/import, including legacy browser backups
- Refresh across browser sessions; open editor text is retained during refresh or save failures

Changing an entry to **Published** makes it accessible without signing in on `/site`. Drafts, review content, scheduled content, workspace settings, and the media library remain private. Changing a published entry back to Draft removes it from the public page and public API. The public page is a simple text publication; it does not modify any of the other websites in the parent folder. Media is stored privately in the database and is not yet attachable to article bodies.

## Move your previous browser content

The old local workspace is never automatically deleted or overwritten.

1. If your browser data is at the same address, use **Settings → Import browser workspace**.
2. If your old workspace used `http://localhost:8080`, open that address in the same browser. The updated connection screen offers **Download browser backup** when old data exists, even without the API. The old static server must still be running to open that address; you can temporarily run `python3 -m http.server 8080` from this folder if necessary.
3. Open the connected app at port 3000, create/sign in to your account, and use **Settings → Import backup**.

Import replaces content, images, and workspace display details after confirmation. It does not change your sign-in account or import old audit messages. The server records the import itself. A fresh database starts empty.

## Backups and recovery

Use **Export backup** for a portable JSON copy of content, media, and workspace details. It excludes login credentials and sessions. Import requests are limited to 20 MB; content is limited to 10,000 entries and 500 images within the media quota.

For a complete server backup, stop the server and copy the entire `data/` directory, including any SQLite sidecar files. Restore that directory while the server is stopped. Keep these backups private because they include account and session data.

If you forget the password, run this locally in an interactive terminal:

```sh
npm run reset-password
```

It prompts for a new password with hidden input and revokes all sessions. Use the same `DATA_DIR` as the running server if you customized it. There is no email recovery service.

## Configuration and hosting

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Listening interface |
| `APP_ORIGIN` | `http://localhost:3000` (uses PORT) | Exact canonical browser origin |
| `DATA_DIR` | `Studio-CMS/data` | Persistent database directory |
| `NODE_ENV` | unset | `production` requires an HTTPS origin |

For a different local port:

```sh
PORT=3001 npm start
```

For hosting, create the owner locally first, provide a persistent disk, run one Node process under a process supervisor, and put it behind an HTTPS reverse proxy. Set `APP_ORIGIN` to the public HTTPS origin and preserve its Host header at the proxy. HTTPS origins enable Secure cookies. The exact Host and browser Origin must match the configured address. Set `HOST=0.0.0.0` only when external connections are intended. Codespaces preview configuration is included; no permanent public deployment has been configured.

This is a single-owner CMS. It does not include team roles, invitation emails, multi-tenant isolation, rich-text/media embedding, or horizontal scaling. All authenticated sessions have owner access. Workspace saves send an atomic snapshot, so this implementation is intended for modest content libraries. Browser refreshes run every 15 seconds and pause while editing or entering settings.

## API

The same-origin API accepts JSON. All writes require `X-Studio-Request: 1`. Authenticated writes additionally require `X-CSRF-Token`, returned by sign-in or the authenticated status endpoint, plus the session cookie. Cross-origin writes are rejected.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Health check |
| GET | `/api/auth/status` | Initial setup/sign-in state; session CSRF token when authenticated |
| POST | `/api/auth/setup` | One-time owner setup: name, email, password |
| POST | `/api/auth/login` | Sign in: email, password |
| POST | `/api/auth/logout` | Revoke current session |
| POST | `/api/auth/password` | Change password: currentPassword, password; revoke other sessions |
| GET | `/api/workspace` | Read authenticated workspace and revision |
| PUT | `/api/workspace` | Save validated workspace with its current revision; 409 on conflict |
| GET | `/api/backup` | Download authenticated JSON content backup |
| PUT | `/api/backup` | Restore content backup using current server revision |
| GET | `/api/public/content` | Public, published-only entries |

Implementation references: [Node SQLite](https://nodejs.org/api/sqlite.html), [Node cryptography](https://nodejs.org/api/crypto.html).

## Verification

```sh
npm test
npm install
npm run test:browser
```

The browser suite uses installed Google Chrome on macOS. Elsewhere run `npx playwright install chromium` first, or set `CHROME_PATH` to your Chrome executable. Tests create isolated temporary databases and do not touch your workspace. Test ports 3197 and 3198 must be available.

Backend tests cover authentication, CSRF/origin enforcement, transactional rollback, stale-save protection, media validation, scheduling, restart persistence, published-only access, escaping, backups, password rotation, and login rate limits. Browser checks cover setup, editing, persistence, media, conflicts, offline errors, backup round-trips, mobile layouts, password changes, and sign-in/sign-out.
