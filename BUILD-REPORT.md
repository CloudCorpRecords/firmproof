# BUILD REPORT — firmproof

Rebuild of `com.fuentio/company-data` (remote-only, keyless capture)
as `@reneturcios/firmproof` 0.1.0 / `io.github.CloudCorpRecords/firmproof`.

## Fixture conflicts

**None.** The brief, the spec prose, and the fixture agree on all 19 tool
names and every required field. Required fields as served, taken from
the fixture (`harness/fixtures/fuentio-company-data-tools-original.json`);
a tool listed with none has **no** `required` key in its served inputSchema:

- `lookup_company` — required: `country`, `identifier`
- `search_companies` — required: `query`, `country`
- `get_company_history` — required: `country`, `identifier`
- `verify_company` — required: `country`, `identifier`
- `get_receipt` — required: `proof_code`, `format`
- `resolve_company` — required: `country`
- `explain_match` — required: `left`, `right`
- `what_changed` — required: `entity_id`, `since`
- `screen_company` — required: `country`, `identifier`
- `check_insolvency` — required: `country`, `identifier`
- `check_address` — required: `country`, `identifier`
- `get_graph` — required: `entity_id`
- `report_issue` — required: `subject`, `category`, `message`
- `get_evidence` — required: `entity_id`
- `check_vat` — required: `country`, `identifier`
- `watch_company` — required: `entity_id`, `callback_url`
- `review_report` — required: `country`, `identifier`
- `check_supplier_list` — required: none (no `required` key served)
- `list_coverage` — required: none (no `required` key served)

The fixture's tool literals (name, title, description, inputSchema —
including every property description, enum, default, `anyOf`/`$defs`
block and length bound) are served verbatim from `src/forward.ts`;
this was verified programmatically at generation time (the `TOOL_DEFS`
array parsed out of `src/forward.ts` deep-equals the fixture's `tools`
array) and again by the registration-integrity test and the parity
harness. The capture's `annotations`, `_meta` and `outputSchema`
blocks are not reproduced, per the spec (parity compares inputSchema).

## What was built

All 19 factory files under `builds/firmproof/`:

- `package.json` (`@reneturcios/firmproof` 0.1.0, bin
  `firmproof` → `dist/cli.js`, deps exactly `@modelcontextprotocol/sdk ^1`
  + `zod ^3`; devDeps `@types/node ^20`, `tsx ^4`, `typescript ^5`)
- `server.json` (description exactly the prescribed 86-char string
  "Official company checks for the UK, France and Spain: lookup, verify, screen, monitor.";
  npm entry carries `"version": "0.1.0"`; OCI entry
  `ghcr.io/cloudcorprecords/firmproof:0.1.0` carries **no** version field)
- `Dockerfile` (node:20-alpine both stages; server-name label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/firmproof"`
  matches `server.json`)
- `tsconfig.json` (fleet-identical, 318 bytes), `.gitignore`,
  `package-lock.json`, `README.md` (fresh prose), `LICENSE` (MIT,
  Copyright (c) 2026 Rene Turcios), `CHANGELOG.md` (single 0.1.0 entry,
  2026-10-27)
- `src/index.ts`, `src/cli.ts`, `src/mcp.ts`, `src/types.ts`,
  `src/forward.ts` (core; exports `VERSION = "0.1.0"`)
- `test/forward.test.ts`
- `.github/workflows/{ci.yml, publish.yml, publish-container.yml,
  registry-publish.yml}` (container workflow: IMAGE
  `ghcr.io/cloudcorprecords/firmproof`, smoke assertion on server name
  `firmproof`)

Plus `BUILD-REPORT.md` (this file) and the `parity-out/` harness output.

## Design

- Forwarding client to `https://api.fuentio.com/mcp` (pinned),
  overridable via `FUENTIO_MCP_URL` (labelled reconstruction).
  tools/call is forwarded as a streamable-HTTP JSON-RPC client:
  initialize (protocolVersion `2025-03-26`, clientInfo `firmproof`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; session established lazily and reused per client.
  Plain-JSON and SSE replies both parsed; the matching-id message
  wins; upstream results pass through verbatim (including `isError`
  and extra fields such as `structuredContent`).
- When `FUENTIO_API_KEY` is set, `X-API-Key: <key>` is sent on every
  upstream request (header name pinned by the registry record;
  forwarding it from this env var is a labelled reconstruction — the
  capture was keyless). When unset, no key header is sent. No
  `Authorization` header is ever sent. All three branches are covered
  by tests.
- Upstream failures (JSON-RPC error, non-2xx status, malformed body,
  throwing/timing-out fetch) surface as `firmproof error:` text
  results (labelled reconstruction).
- Registration via the MCP SDK **low-level** `Server` API
  (`ListToolsRequestSchema` / `CallToolRequestSchema` handlers) serving
  the fixture literals exactly; no `McpServer` + zod registration.
  `src/mcp.ts` also exports `createServer` / `startMcpServer` /
  `handleCallTool` so the MCP layer is testable without a transport;
  the CLI's `mcp` subcommand starts it over stdio.
- Core takes an injectable fetch (`ForwardDeps.fetchFn`), so all tests
  run against a stubbed JSON-RPC upstream. No live network calls in
  tests; no live call claimed anywhere. `watch_company` is served and
  forwarded exactly as captured: it registers the caller's own https
  callback URL for their own monitoring subscription, per the spec.

## Lockfile (Route 3, clean from birth)

Generated in a temp dir (`/tmp/firmproof-lock`) containing only the new
`package.json`: `npm install --package-lock-only --ignore-scripts
--offline`. Verified: parses, `name == @reneturcios/firmproof`,
**128 package entries**; copied into the build dir with matching
sha256 (`6251a873…ec300` on both sides: full value
`6251a873535a94bb4e8de59f3cec3ae8f12003e1537191ccca79467ae2bec300`).
Then `npm install --offline --ignore-scripts` in the build dir for
`node_modules`. No write-guard failure occurred; the /tmp staging was
the Route 3 generation step itself, not a fallback.

## Verification (all in the build dir unless noted)

- `npx tsc --noEmit` → exit 0
- `npm run build` → real `dist/` (cli.js 2339 B, forward.js 64237 B,
  mcp.js 2681 B, all non-empty, with `.d.ts` + source maps)
- `node dist/cli.js --version` → `0.1.0`; unknown subcommand → usage on
  stderr, exit 2
- `npm test` → **57 tests, 57 pass, 0 fail** (8 suites: registration
  integrity — served tools deep-equal the fixture's full 19 tool
  objects, names in order, required fields per tool, and no `required`
  key for `check_supplier_list` / `list_coverage`; session
  establishment/reuse/session-id handling; env URL override;
  X-API-Key header present on every request when the key is set /
  absent when unset / no Authorization header in either case; verbatim
  argument forwarding for named tools plus one generated forwarding
  test per tool for all 19 tools; verbatim result pass-through incl.
  upstream isError and SSE; JSON-RPC/init/malformed/HTTP/throw/
  timeout failures → `firmproof error:`; parseRpcBody; MCP-layer
  validation; CLI --version / unknown exit 2 / bad-JSON exit 2)
- Parity: `python3 harness/parity.py --original
  harness/fixtures/fuentio-company-data-tools-original.json --rebuild
  "stdio:node builds/firmproof/dist/cli.js mcp" --out
  builds/firmproof/parity-out` (run from `~/workspace/mcp-rebuild-100`)
  → **PASS, parity 100.0, 19/19 identical, no missing/extra/schema
  diffs** (see `parity-out/parity.json`)
- Consistency sweep: package.json version = server.json top-level =
  npm-entry version = OCI tag = core `VERSION` = CHANGELOG heading
  (0.1.0); package.json `mcpName` = server.json `name` = Dockerfile
  label; server.json description measured at 86 chars; OCI entry
  confirmed to have no `version` field.

Clean-room: all prose and code written fresh for firmproof; only the
mechanics were patterned on the sibling simscout build, and only the
fixture's tool literals are served verbatim.
