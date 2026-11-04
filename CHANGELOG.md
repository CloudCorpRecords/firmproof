# Changelog

## 0.1.0 (2026-10-27)

- First release: a forwarding client for the hosted Fuentio company-data MCP server, serving all 19 captured tools locally for tools/list and forwarding every tools/call upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when issued).
- Tools: `lookup_company`, `search_companies`, `get_company_history`, `verify_company`, `get_receipt`, `resolve_company`, `explain_match`, `what_changed`, `screen_company`, `check_insolvency`, `check_address`, `get_graph`, `report_issue`, `get_evidence`, `check_vat`, `watch_company`, `review_report`, `check_supplier_list`, `list_coverage`.
- Upstream results pass through verbatim; upstream failures surface as `firmproof error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). Upstream endpoint overridable via `FUENTIO_MCP_URL`; when `FUENTIO_API_KEY` is set it is sent as an `X-API-Key` header on every upstream request.
