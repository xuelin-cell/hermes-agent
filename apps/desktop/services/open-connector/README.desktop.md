# Desktop OpenConnector runtime

Independent Apache-2.0 service migrated from the local HexAgent checkout (`libs/open-connector`, version 1.4.1). LICENSE.txt and NOTICE.md retain upstream terms. Source, generated catalog, migrations and dependency lock are preserved. Only the 11 recommended providers are shipped; the entry point selects registry.desktop.ts. User databases, environment files and node_modules are not migrated.

Install runtime dependencies from this directory with `npm ci --omit=dev --workspaces=false --ignore-scripts`. The generated catalog is already included; do not run the upstream postinstall generator for the reduced provider set. Requires a Node runtime supporting native TypeScript and node:sqlite (Electron runs it as a Node child).

Electron owns per-profile storage, encrypted keys, admin authentication, lifecycle and MCP registration. Hermes Python code does not import this service.
