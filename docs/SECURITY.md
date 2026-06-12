# Security model for the BDP Cloud MVP

## Threats this MVP addresses

- The CIE/BDP session is not stored as plain JSON.
- Session state is encrypted at rest with AES-256-GCM.
- A minimal HTTP-only cookie protects API endpoints.
- BDP document reader refuses non-BDP URLs.
- CIE browser flows expire and are kept only in memory.

## Threats this MVP does not fully address

- The app uses a shared password, not enterprise SSO.
- There is no tenant administration UI.
- There is no per-matter access control.
- Browser egress is not firewall-restricted in code.
- There is no worker sandbox beyond container isolation.
- There is no production audit log.
- There is no data-retention policy enforcement.

## Recommended production controls

1. Replace `APP_PASSWORD` with SSO using OIDC/SAML.
2. Store each user's encrypted BDP session in a managed KMS-backed database.
3. Add explicit consent before saving a CIE-authenticated browser session.
4. Add a one-click revoke/delete session control.
5. Run each Playwright job in an isolated container with short TTL.
6. Restrict browser outbound domains to BDP and official auth providers.
7. Keep logs metadata-only by default.
8. Add rate limits and bot controls.
9. Run a DPIA/legal review for GDPR and professional secrecy.
10. Create a production incident response procedure.
