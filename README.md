# firmproof

firmproof is a small local bridge to Fuentio's hosted
MCP server, which checks companies against the official
registers of France, Spain and the United Kingdom. Give
it an official ID — a French SIREN, a Spanish Registro
Mercantil sheet, a UK Companies House number — and it
can read the register record, verify the company for
onboarding, screen it against sanctions lists, check
insolvency and address and VAT, and follow what changed
over time, each answer carrying its official source.

The bridge keeps no register data of its own. It serves
the upstream server's tool list locally, exactly as
captured from the live endpoint, and forwards each tool
call upstream, returning the result untouched.

## Tools

- `lookup_company` — one company by official ID: status,
  address, legal form, activity, source and check date.
  Required: `country` (`FR`, `ES` or `GB`), `identifier`.
- `search_companies` — find companies by name, 10 per
  page, each with a match score. Required: `query`,
  `country`.
- `get_company_history` — versions of a company's record
  with the fields that changed and their sources.
  Required: `country`, `identifier`.
- `verify_company` — a registry verification with an
  outcome, reasons, checks, warning signals and a proof
  code for an auditor. Required: `country`, `identifier`.
- `get_receipt` — the receipt of an earlier verification
  by its proof code. Required: `proof_code`, `format`
  (`normal` or `detailed`).
- `resolve_company` — decide whether a record you hold
  is a company in the registers, with evidence and
  candidate decisions. Required: `country`.
- `explain_match` — why two register records are, or are
  not, the same company. Required: `left`, `right`.
- `what_changed` — what changed at a company since a
  date. Required: `entity_id`, `since`.
- `screen_company` — screen a company's names against
  sanctions lists. Required: `country`, `identifier`.
- `check_insolvency` — insolvency notices and state from
  BODACC and BORME. Required: `country`, `identifier`.
- `check_address` — validate a registered address
  against the official address base. Required:
  `country`, `identifier`.
- `get_graph` — a company's group: GLEIF parents and
  subsidiaries. Required: `entity_id`.
- `report_issue` — report a wrong or missing answer for
  re-checking against the official source. Required:
  `subject`, `category`, `message`.
- `get_evidence` — the evidence behind a company's
  facts, field by field with sources. Required:
  `entity_id`.
- `check_vat` — a company's EU VAT number and how it was
  obtained (registration itself is never checked).
  Required: `country`, `identifier`.
- `watch_company` — register your own https endpoint to
  be notified when a company's records change. Required:
  `entity_id`, `callback_url`.
- `review_report` — one review-ready report combining
  identity, facts, a year of changes and every check.
  Required: `country`, `identifier`.
- `check_supplier_list` — check 2 to 100 suppliers at
  once, or read a batch you started. No required fields:
  pass `rows` or `batch_id`.
- `list_coverage` — the countries, ID formats and
  official sources covered. Takes no arguments.

## Configuration

- `FUENTIO_MCP_URL` (optional) — override the upstream
  endpoint. Defaults to `https://api.fuentio.com/mcp`.
  (The override hook is this rebuild's own labelled
  reconstruction.)
- `FUENTIO_API_KEY` (optional) — when set, every
  upstream request carries an `X-API-Key: <key>` header.
  Some upstream tools require a key, and a free key is
  obtainable from the vendor. When it is not set, no key
  header is sent. No `Authorization` header is ever sent.
  (This forwarding is also a labelled reconstruction;
  the original surface was captured keyless.)

### Forwarding mechanics

On the first tool call the client opens a streamable
HTTP session with the upstream: a JSON-RPC `initialize`
request (protocolVersion `2025-03-26`, clientInfo name
`firmproof`), then a `notifications/initialized`
notification, then the `tools/call` request carrying
the caller's arguments unchanged. When the upstream
answers `initialize` with an `Mcp-Session-Id` header,
that value rides on every later request of the session,
which is reused for the life of the process. Replies
may arrive as plain JSON or as server-sent events;
both are read.

Successful upstream results pass through verbatim,
including any `isError` flag the upstream sets.
Failures — a JSON-RPC error, a non-2xx status, an
unreadable response, or a request that cannot be
completed — come back as an `isError` result whose
text starts with `firmproof error:` (this rendering
is this rebuild's own labelled reconstruction).

## CLI

Each tool is also a subcommand taking one JSON argument
string (omit it for tools that take none):

```bash
npx @reneturcios/firmproof lookup_company '{"country":"FR","identifier":"441639465"}'
npx @reneturcios/firmproof search_companies '{"country":"FR","query":"renault"}'
npx @reneturcios/firmproof verify_company '{"country":"GB","identifier":"00445790"}'
npx @reneturcios/firmproof list_coverage
npx @reneturcios/firmproof --version
```

Exit codes: `0` on success, `1` on an `isError`
result, `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/firmproof mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "firmproof": {
      "command": "npx",
      "args": ["-y", "@reneturcios/firmproof", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/firmproof
docker run --rm ghcr.io/cloudcorprecords/firmproof --version
```

The container's default command is `mcp`, so the first
form is a stdio MCP server; any other arguments reach
the CLI normally.

## Development

```bash
npm install
npm run build
npm test
npm run dev
```

The test suite runs entirely against a stubbed
JSON-RPC upstream — no live network calls.

## License

MIT — see `LICENSE`.
