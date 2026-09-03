# Keycloak realm

`realm-optiwork.json` is imported on first start by `start-dev --import-realm`.

It defines the eight OptiWork roles, a bearer-only `optiwork-api` client, a
public `optiwork-web` client for the browser login, and a confidential
`optiwork-payments` service account for machine-to-machine calls. A protocol
mapper puts `organization_id` and `roles` into the access token; the API
requires both.

Every password in this file is a well-known local development value. It exists
so a reviewer can start the stack in one command. **Do not reuse any of it
outside a local machine**, and never commit a generated client secret: read it
from the Keycloak admin console after first start and pass it through the
environment.

The demo profile does not need Keycloak at all - `AUTH_MODE=demo` accepts a
local principal token so the walkthrough runs offline.
