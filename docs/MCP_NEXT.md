# Adding remote MCP later

This MVP is web-first: the user opens a hosted HTML page and does not install a local MCP client.

A later version can expose the same BDP functions as remote MCP tools over Streamable HTTP:

- `bdp_check_session`
- `bdp_start_cie_login`
- `bdp_search`
- `bdp_read_document`
- `bdp_delete_session`

Keep these as thin wrappers around `src/bdp/client.js` and `src/auth/flows.js`.

Do not expose remote MCP without authentication, origin validation, rate limits, and per-user session isolation.
