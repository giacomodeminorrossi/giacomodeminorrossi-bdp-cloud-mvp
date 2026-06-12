# BDP Cloud MVP

Cloud-only prototype inspired by the local `mcp-bdm-civile` project.

The goal is that the lawyer does not install Node.js, Playwright, Claude Desktop, or a local MCP server. The hosted web app runs a server-side Playwright browser, shows its screen in an HTML page, lets the user complete CIE authentication with the CieID phone app, saves the resulting BDP browser session encrypted on the server, and then performs BDP search/read operations from the hosted UI.

## What this includes

- Express web app
- Static HTML/CSS/JS interface
- Server-side Playwright Chromium
- Cloud CIE login flow using screenshots and remote clicks
- AES-256-GCM encrypted storage of Playwright `storageState`
- BDP search endpoint
- BDP document reader endpoint
- Dockerfile based on the official Playwright image
- Render Blueprint example

## What this does not include yet

- Real production identity provider / SSO
- Full MCP Streamable HTTP wrapper
- Queue-based Playwright worker pool
- Database-backed tenant management
- Legal/compliance approval
- Verified BDP selectors for every possible page state
- AI summarization layer

## Environment variables

Required in production:

```bash
APP_PASSWORD=your-long-app-password
SESSION_ENCRYPTION_KEY=base64-encoded-32-random-bytes
COOKIE_SECRET=another-long-random-secret
```

For the included Render Blueprint, only `APP_PASSWORD` must be typed manually. `SESSION_ENCRYPTION_KEY` and `COOKIE_SECRET` use Render `generateValue: true`, which generates base64 256-bit secrets. If you deploy on another host, `SESSION_ENCRYPTION_KEY` must decode to exactly 32 bytes. Store all secrets as cloud secrets. Do not commit them.

## Deploy without installing locally

### Option A: Render web UI deployment

1. Create a new empty GitHub repository using the GitHub website.
2. Upload the files in this folder through the GitHub web interface.
3. In Render, create a new Blueprint or Docker web service from that repository.
4. Add `APP_PASSWORD` as a Render secret. `SESSION_ENCRYPTION_KEY` and `COOKIE_SECRET` are generated automatically by `render.yaml`.
5. Confirm the persistent disk is mounted at `/data` so encrypted sessions survive restarts.
6. Open the Render URL.
7. Log into the prototype with `APP_PASSWORD`.
8. Click **Start CIE login**.
9. Use the displayed cloud-browser screenshot to click through the login page if needed.
10. Scan the CIE QR code with the CieID phone app.
11. After the browser lands back on BDP, click **Finish and save session**.
12. Search BDP from the web page.

### Option B: Any Docker-capable host

Deploy this repository as a Docker web service. The container listens on `PORT`, defaults to 3000, and needs a writable persistent volume at `/data`.

## How the cloud CIE login works

The hosted server launches a headless Chromium instance. The web page shows screenshots of that browser. The user can click the screenshot, and the server sends the click to the real browser. When the CIE QR code appears, the user scans it with the phone. The phone performs NFC/PIN checks with the physical CIE. When BDP receives the authentication result, the server saves the browser storage state encrypted.

## Security notes

This is a prototype. Before production:

- Put the app behind SSO or firm VPN.
- Replace the shared `APP_PASSWORD` with real user authentication.
- Store encrypted session blobs in a managed secret store or encrypted database.
- Log access events without logging legal text unnecessarily.
- Add per-user tenant isolation.
- Add session deletion and expiry policies.
- Review BDP terms of use, professional secrecy, GDPR, and client confidentiality requirements.
- Restrict outbound browser access to BDP and required CIE authentication domains.

## Important files

```text
src/server.js                  Express routes
src/auth/flows.js              Cloud CIE browser flow
src/auth/session-store.js      Encrypted Playwright storageState store
src/bdp/client.js              BDP search and document extraction logic
src/browser/playwright.js      Chromium launch configuration
src/security/app-auth.js       Minimal password/cookie protection
public/index.html              Web page
public/app.js                  Browser-side UI logic
Dockerfile                     Cloud deployment image
render.yaml                    Render Blueprint example
```

## Next production step

After this MVP works with a real CIE account, split Playwright into a worker service and keep the web app as a control plane:

```text
web app -> job queue -> isolated browser worker -> BDP
```

That gives better security, auditability, and scaling.

## Free Render smoke-test variant

This package is configured with `plan: free` in `render.yaml` and no persistent disk. It is intended only to confirm that the app builds and opens in the browser. Because there is no persistent disk, encrypted BDP sessions stored under `/data` can be lost after redeploys, restarts, or free-service spin-downs.
