/**
 * firmproof core: a forwarding client for the hosted
 * Fuentio company-data MCP server.
 *
 * Nothing is computed locally. tools/list is answered
 * from the literal tool definitions below, taken verbatim
 * from a live capture of the upstream server (name, title,
 * description and inputSchema exactly as captured; the
 * capture's annotations, _meta and outputSchema blocks
 * are not reproduced). A tools/call is forwarded over a
 * streamable-HTTP JSON-RPC session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, honouring the Mcp-Session-Id response header when
 * the upstream issues one. The session is established
 * lazily on the first forwarded call and reused for the
 * lifetime of the client.
 *
 * The upstream endpoint is pinned to
 * https://api.fuentio.com/mcp and can be overridden with
 * the FUENTIO_MCP_URL environment variable (that override
 * is a labelled reconstruction). When FUENTIO_API_KEY is
 * set in the environment, every upstream request carries
 * an `X-API-Key: <key>` header (the header name is pinned
 * by the registry record; forwarding it from this env var
 * is a labelled reconstruction - the capture itself was
 * taken keyless). When the variable is unset, no key
 * header is sent and no Authorization header is ever
 * sent.
 *
 * Upstream results pass through verbatim, including any
 * isError flag and any extra result fields. Failures - a
 * JSON-RPC error from the upstream, a non-2xx status, an
 * unparseable response, or a fetch that throws or times
 * out - surface as an isError result whose text starts
 * with `firmproof error:` (that rendering is a labelled
 * reconstruction). Responses may be plain JSON or SSE
 * (data: lines); the JSON-RPC message with the matching
 * id wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://api.fuentio.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/fuentio-company-data-tools-original.json) */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "lookup_company",
    "title": "Look up a company by official ID",
    "description": "Look up one company in its official register by ID: status, address, legal form, activity, source and check date.\nUse it when you have an official ID. Don't use it with a name: call search_companies first.\nInputs: country FR or ES or GB; identifier. FR: SIREN 441639465, SIRET 44163946500091, VAT FR63441639465, LEI 969500F7JLTX36OUI695. ES: Registro Mercantil sheet VI-23266, LEI 549300EEJH4FEPDBBR25 (no NIF/CIF). GB: company number 00445790, LEI 2138002P5RNKC5W2JZ46. Optional: id_scheme (if ambiguous), format (json, csv, tsv, markdown, html, xml, ndjson; xlsx or parquet as a 24 h link).\nReturns: the record, a one-line summary, meta with source, source_url, last_verified_at.\nLimits: 1 unit (also a valid ID not found); keyless 20/day. France: insolvency from BODACC since 2008. Public contracts won since 2024 (DECP, weekly). Spain: BORME acts since 2 January 2009. UK: no officers or PSCs. No person's name in any answer.\nFor KYB steps, supplier checks, due diligence: SIREN, RCS, Annuaire des Entreprises, société; BORME, Registro Mercantil, empresa, sociedad; Companies House, company number, Ltd, plc, LLP.",
    "inputSchema": {
      "properties": {
        "country": {
          "description": "ISO country code: FR or ES or GB.",
          "enum": [
            "FR",
            "ES",
            "GB"
          ],
          "examples": [
            "FR"
          ],
          "title": "Country",
          "type": "string"
        },
        "identifier": {
          "description": "Official ID. FR: SIREN (9 digits), SIRET (14) or VAT (FR + 11). ES: Registro Mercantil sheet, e.g. VI-23266. GB: Companies House company number, e.g. 00445790.",
          "examples": [
            "441639465",
            "VI-23266",
            "00445790"
          ],
          "maxLength": 64,
          "title": "Identifier",
          "type": "string"
        },
        "id_scheme": {
          "anyOf": [
            {
              "enum": [
                "FR_SIREN",
                "FR_SIRET",
                "EU_VAT",
                "LEI",
                "ES_RM_HOJA",
                "ES_NIF",
                "GB_COMPANY_NUMBER"
              ],
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Optional: force the ID type when it is ambiguous.",
          "examples": [
            "FR_SIRET"
          ],
          "title": "Id Scheme"
        },
        "format": {
          "default": "json",
          "description": "Answer format: json (default); csv, tsv, markdown, html (table), xml or ndjson come back inline, one row per company with source and fetched_at; xlsx or parquet as a download link valid 24 hours. Same units; search takes limit (up to 100 rows) with a non-json format.",
          "enum": [
            "json",
            "csv",
            "tsv",
            "xlsx",
            "markdown",
            "html",
            "xml",
            "ndjson",
            "parquet"
          ],
          "examples": [
            "csv"
          ],
          "title": "Format",
          "type": "string"
        },
        "detail": {
          "default": "standard",
          "description": "summary: a few key fields; standard (default): the record, long lists shortened; full: everything.",
          "enum": [
            "summary",
            "standard",
            "full"
          ],
          "examples": [
            "summary"
          ],
          "title": "Detail",
          "type": "string"
        }
      },
      "required": [
        "country",
        "identifier"
      ],
      "type": "object",
      "title": "lookup_companyArguments"
    }
  },
  {
    "name": "search_companies",
    "title": "Search companies by name",
    "description": "Find companies by name in the official registers of France, Spain and United Kingdom, 10 per page.\nUse it when you know a name but no ID, then call lookup_company or verify_company with an ID from the results. Don't use it when you already have an official ID.\nInputs: country FR or ES or GB; query, 2 to 200 characters ('telefonica'). Optional: postal_code, locality, status, jurisdiction (regional registers), page, format; limit (up to 100 rows) with a file format.\nReturns: best match first, each with match.score (0-1) and reasons, name, status, address, IDs, provenance; meta.next_page.\nLimits: 2 units a page; files 2 per started 25 rows. Read-only. France: insolvency from BODACC since 2008. Public contracts won since 2024 (DECP, weekly). Spain: BORME acts since 2 January 2009. UK: no officers or PSCs. No person's name in any answer.\nSearch words: SIREN, RCS, Annuaire des Entreprises, société; BORME, Registro Mercantil, empresa, sociedad; Companies House, company number, Ltd, plc, LLP, KYB, supplier check.",
    "inputSchema": {
      "properties": {
        "query": {
          "description": "Company name, 2 to 200 characters.",
          "examples": [
            "renault",
            "telefonica"
          ],
          "maxLength": 200,
          "title": "Query",
          "type": "string"
        },
        "country": {
          "description": "ISO country code: FR or ES or GB.",
          "enum": [
            "FR",
            "ES",
            "GB"
          ],
          "examples": [
            "FR"
          ],
          "title": "Country",
          "type": "string"
        },
        "postal_code": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Registered-office postal code filter.",
          "examples": [
            "92100"
          ],
          "title": "Postal Code"
        },
        "locality": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Registered-office town filter (Spain).",
          "examples": [
            "MADRID"
          ],
          "title": "Locality"
        },
        "status": {
          "anyOf": [
            {
              "enum": [
                "active",
                "inactive",
                "in_liquidation",
                "dissolved",
                "struck_off",
                "unknown"
              ],
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Only companies with this status.",
          "examples": [
            "active"
          ],
          "title": "Status"
        },
        "page": {
          "default": 1,
          "description": "Results page, 10 per page.",
          "examples": [
            1
          ],
          "minimum": 1,
          "title": "Page",
          "type": "integer"
        },
        "jurisdiction": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Optional ISO 3166-2 region to search in, for countries with regional registers (list_coverage lists them).",
          "title": "Jurisdiction"
        },
        "format": {
          "default": "json",
          "description": "Answer format: json (default); csv, tsv, markdown, html (table), xml or ndjson come back inline, one row per company with source and fetched_at; xlsx or parquet as a download link valid 24 hours. Same units; search takes limit (up to 100 rows) with a non-json format.",
          "enum": [
            "json",
            "csv",
            "tsv",
            "xlsx",
            "markdown",
            "html",
            "xml",
            "ndjson",
            "parquet"
          ],
          "examples": [
            "csv"
          ],
          "title": "Format",
          "type": "string"
        },
        "limit": {
          "anyOf": [
            {
              "maximum": 100,
              "minimum": 1,
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Rows in one file, up to 100, with a non-json format only. 2 units per started 25 rows (100 rows = 8 units).",
          "examples": [
            50
          ],
          "title": "Limit"
        }
      },
      "required": [
        "query",
        "country"
      ],
      "type": "object",
      "title": "search_companiesArguments"
    }
  },
  {
    "name": "get_company_history",
    "title": "See what changed at a company",
    "description": "See what changed at a company, and when: versions with the fields that changed (address, status), each with its official source.\nUse it for changes over time. Don't use it for the current state: call lookup_company.\nInputs: country FR or ES or GB; identifier as for lookup_company (441639465); optional id_scheme; page.\nReturns: versions newest first with source, fetched_at and the fields changed; dated events where the source has them (BORME acts, Companies House filings). meta.history_since says where history starts.\nLimits: 1 unit; keyless 20 units a day. Read-only. France: from Fuentio's first fetch of the company. Spain: from 2 January 2009. United Kingdom: the latest filings, and every change since Fuentio first held it.\nSearch words: historique, historial, cambios, due diligence.",
    "inputSchema": {
      "properties": {
        "country": {
          "description": "ISO country code: FR or ES or GB.",
          "enum": [
            "FR",
            "ES",
            "GB"
          ],
          "examples": [
            "FR"
          ],
          "title": "Country",
          "type": "string"
        },
        "identifier": {
          "description": "Official ID, as for lookup_company.",
          "examples": [
            "441639465",
            "VI-23266"
          ],
          "maxLength": 64,
          "title": "Identifier",
          "type": "string"
        },
        "page": {
          "default": 1,
          "description": "Versions page, 10 per page.",
          "examples": [
            1
          ],
          "minimum": 1,
          "title": "Page",
          "type": "integer"
        },
        "id_scheme": {
          "anyOf": [
            {
              "enum": [
                "FR_SIREN",
                "FR_SIRET",
                "EU_VAT",
                "LEI",
                "ES_RM_HOJA",
                "ES_NIF",
                "GB_COMPANY_NUMBER"
              ],
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Optional: force the ID type when it is ambiguous.",
          "examples": [
            "FR_SIRET"
          ],
          "title": "Id Scheme"
        },
        "detail": {
          "default": "standard",
          "description": "summary: a few key fields; standard (default): the record, long lists shortened; full: everything.",
          "enum": [
            "summary",
            "standard",
            "full"
          ],
          "examples": [
            "summary"
          ],
          "title": "Detail",
          "type": "string"
        }
      },
      "required": [
        "country",
        "identifier"
      ],
      "type": "object",
      "title": "get_company_historyArguments"
    }
  },
  {
    "name": "verify_company",
    "title": "Verify a company (registry check)",
    "description": "Verify a company against its official register, for onboarding or before paying or signing: an outcome with reasons, checks, warning signals and a proof code you can show an auditor. A registry check, not full KYB.\nUse it to decide about a company. Don't use it for a cheap single read (lookup_company) or with a name (call search_companies first).\nInputs: country FR or ES or GB; identifier as for lookup_company (441639465); optional id_scheme; optional reference (your case id).\nReturns: outcome (verified, partial, unverified; open insolvency never verified) + reasons, checks, signals (present, none_found, not_covered), recent changes, provenance, proof code (FUE-…).\nLimits: 5 units (1 if not found); keyless 20/day. Stored 24 months. France: insolvency from BODACC since 2008. Public contracts won since 2024 (DECP, weekly). Spain: BORME acts since 2 January 2009. UK: no officers or PSCs. No person's name in any answer.\nSearch words: KYB, KYC, verify supplier, vérifier une société, verificar empresa.",
    "inputSchema": {
      "properties": {
        "country": {
          "description": "ISO country code: FR or ES or GB.",
          "enum": [
            "FR",
            "ES",
            "GB"
          ],
          "examples": [
            "FR"
          ],
          "title": "Country",
          "type": "string"
        },
        "identifier": {
          "description": "Official ID: FR SIREN or SIRET; ES Registro Mercantil sheet from search_companies. GB: Companies House company number, e.g. 00445790. Never a name.",
          "examples": [
            "441639465",
            "VI-23266",
            "00445790"
          ],
          "maxLength": 64,
          "title": "Identifier",
          "type": "string"
        },
        "id_scheme": {
          "anyOf": [
            {
              "enum": [
                "FR_SIREN",
                "FR_SIRET",
                "EU_VAT",
                "LEI",
                "ES_RM_HOJA",
                "ES_NIF",
                "GB_COMPANY_NUMBER"
              ],
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Optional: force the ID type.",
          "examples": [
            "FR_SIRET"
          ],
          "title": "Id Scheme"
        },
        "reference": {
          "anyOf": [
            {
              "maxLength": 200,
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Optional: your own case id, stored with the result.",
          "examples": [
            "onboarding-2026-0042"
          ],
          "title": "Reference"
        },
        "detail": {
          "default": "standard",
          "description": "summary: a few key fields; standard (default): the record, long lists shortened; full: everything.",
          "enum": [
            "summary",
            "standard",
            "full"
          ],
          "examples": [
            "summary"
          ],
          "title": "Detail",
          "type": "string"
        }
      },
      "required": [
        "country",
        "identifier"
      ],
      "type": "object",
      "title": "verify_companyArguments"
    }
  },
  {
    "name": "get_receipt",
    "title": "Get a verification receipt by proof code",
    "description": "Give back the Fuentio receipt of a verification by its proof code: outcome and reasons, status, legal form, registered office, insolvency (what was searched), source, check time, hash and the public link to check it.\nUse it when the user asks for a receipt or proof of a check. Always ask the user first: 'Normal or detailed receipt?', then call it. Use the proof code from verify_company. Don't use it to run a new check: call verify_company.\nInputs: proof_code (e.g. 'FUE-FR-20261015-DZ7TP9', any case; a lookup's meta.receipt.request_id also works, same key), format 'normal' or 'detailed'.\nReturns: data.markdown, the branded receipt: show it as is; data.text, plain text.\nLimits: free; 30 a minute. The key that ran the check also sees its reference; anyone else, the public view. Read-only.",
    "inputSchema": {
      "properties": {
        "proof_code": {
          "description": "The proof code verify_company returned (FUE-XX-YYYYMMDD-XXXXXX; any case or spacing), or a lookup's meta.receipt.request_id.",
          "examples": [
            "FUE-FR-20261015-DZ7TP9"
          ],
          "maxLength": 60,
          "minLength": 1,
          "title": "Proof Code",
          "type": "string"
        },
        "format": {
          "description": "Ask the user first: 'normal' (the receipt) or 'detailed' (also every check, the signals, changes, sources and the full hash re-checked).",
          "enum": [
            "normal",
            "detailed"
          ],
          "examples": [
            "normal"
          ],
          "title": "Format",
          "type": "string"
        }
      },
      "required": [
        "proof_code",
        "format"
      ],
      "type": "object",
      "title": "get_receiptArguments"
    }
  },
  {
    "name": "resolve_company",
    "title": "Is this the same company? (match with evidence)",
    "description": "Decide whether a company you know (an official ID, or a name with a postcode or town) is a company in the official registers, with evidence: candidates each with a decision, linked, possible or rejected, and the reasons.\nUse it to match a supplier or customer record to a register record. Don't use it to read a company you already identified: call lookup_company.\nInputs: country FR or ES or GB; name ('Renault', postal_code '92100') and/or identifier (441639465); optional id_scheme, locality, limit (1-10).\nReturns: outcome (linked, possible_match, no_match), uncertainty, best, candidates with entity_id, reason codes and evidence.\nLimits: 2 units. Only an official ID links: a name, even with an address, is never proof. Read-only, nothing stored.",
    "inputSchema": {
      "properties": {
        "country": {
          "description": "ISO country code: FR or ES or GB.",
          "enum": [
            "FR",
            "ES",
            "GB"
          ],
          "examples": [
            "FR"
          ],
          "title": "Country",
          "type": "string"
        },
        "name": {
          "anyOf": [
            {
              "maxLength": 200,
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "The company's name as you have it.",
          "examples": [
            "Renault"
          ],
          "title": "Name"
        },
        "identifier": {
          "anyOf": [
            {
              "maxLength": 64,
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "An official ID, if you have one: the only thing that links exactly.",
          "examples": [
            "441639465"
          ],
          "title": "Identifier"
        },
        "id_scheme": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Optional: force the ID type.",
          "examples": [
            "LEI"
          ],
          "title": "Id Scheme"
        },
        "postal_code": {
          "anyOf": [
            {
              "maxLength": 20,
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "examples": [
            "92100"
          ],
          "title": "Postal Code"
        },
        "locality": {
          "anyOf": [
            {
              "maxLength": 100,
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "examples": [
            "Boulogne-Billancourt"
          ],
          "title": "Locality"
        },
        "limit": {
          "default": 5,
          "description": "Candidates.",
          "maximum": 10,
          "minimum": 1,
          "title": "Limit",
          "type": "integer"
        }
      },
      "required": [
        "country"
      ],
      "type": "object",
      "title": "resolve_companyArguments"
    }
  },
  {
    "name": "explain_match",
    "title": "Why two records are (or aren't) the same company",
    "description": "Explain why two register records are, or are not, the same company: today's decision with reason codes and evidence, stored decisions, links, and whether they share one Fuentio entity.\nUse it after resolve_company or lookup_company when you must justify a match or a rejection. Don't use it to find companies: call resolve_company.\nInputs: left and right, Fuentio record IDs (e.g. 'FR-SIREN-441639465', 'FR-LEI-969500F7JLTX36OUI695').\nReturns: same_entity, summary, decision (status, band, reasons), stored_decisions, links, uncertainty.\nLimits: 1 unit. Read-only.",
    "inputSchema": {
      "properties": {
        "left": {
          "description": "A Fuentio record ID.",
          "examples": [
            "FR-SIREN-441639465"
          ],
          "maxLength": 80,
          "title": "Left",
          "type": "string"
        },
        "right": {
          "description": "Another record ID.",
          "examples": [
            "FR-LEI-969500F7JLTX36OUI695"
          ],
          "maxLength": 80,
          "title": "Right",
          "type": "string"
        }
      },
      "required": [
        "left",
        "right"
      ],
      "type": "object",
      "title": "explain_matchArguments"
    }
  },
  {
    "name": "what_changed",
    "title": "What changed at a company since a date",
    "description": "List what changed at a company since a date, from every official record Fuentio holds for it: status, name, address, legal form, and the source's dated events (BORME acts), each with its source and evidence.\nUse it to review a supplier or customer since your last check. Don't use it for the current state: call lookup_company.\nInputs: entity_id (from resolve_company, e.g. 'fu_7K3M9Q2XH4PZ'), since 'YYYY-MM-DD', optional until.\nReturns: changes (type, old/new or added/removed, observed_at or effective_date, source, evidence), gaps (days not loaded, sources not checked since), uncertainty.\nLimits: 1 unit. A gap is never reported as no change. Read-only.",
    "inputSchema": {
      "properties": {
        "entity_id": {
          "description": "A Fuentio entity ID (from resolve_company).",
          "examples": [
            "fu_7K3M9Q2XH4PZ"
          ],
          "maxLength": 20,
          "title": "Entity Id",
          "type": "string"
        },
        "since": {
          "description": "YYYY-MM-DD.",
          "examples": [
            "2026-01-01"
          ],
          "title": "Since",
          "type": "string"
        },
        "until": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "YYYY-MM-DD; default today.",
          "examples": [
            null
          ],
          "title": "Until"
        }
      },
      "required": [
        "entity_id",
        "since"
      ],
      "type": "object",
      "title": "what_changedArguments"
    }
  },
  {
    "name": "screen_company",
    "title": "Screen a company against sanctions lists",
    "description": "Screen a company's own names against sanctions lists: EU Financial Sanctions File, UK Sanctions List, OFAC SDN list, France's registre des gels.\nUse it as the sanctions-list step of onboarding a supplier or customer (not full KYB). Don't use it to identify a company: call resolve_company or lookup_company first.\nInputs: country and identifier, as lookup_company (e.g. 'FR', '441639465').\nReturns: result 'possible_match' (list, entry, score, reasons, listing date, legal act, official link), 'no_match_found' or 'not_checked', the list versions, and a note.\nLimits: 2 units; API key required. A possible match is not proof; no match is never 'clear'. Read-only.",
    "inputSchema": {
      "properties": {
        "country": {
          "description": "ISO country code: FR or ES or GB.",
          "enum": [
            "FR",
            "ES",
            "GB"
          ],
          "examples": [
            "FR"
          ],
          "title": "Country",
          "type": "string"
        },
        "identifier": {
          "description": "Official ID, as lookup_company: FR SIREN (9 digits), SIRET or VAT; ES Registro Mercantil sheet, e.g. VI-23266. GB: Companies House company number, e.g. 00445790.",
          "examples": [
            "441639465",
            "VI-23266",
            "00445790"
          ],
          "maxLength": 64,
          "title": "Identifier",
          "type": "string"
        }
      },
      "required": [
        "country",
        "identifier"
      ],
      "type": "object",
      "title": "screen_companyArguments"
    }
  },
  {
    "name": "check_insolvency",
    "title": "Insolvency notices and state of a company",
    "description": "Check a company's insolvency notices and state: France from BODACC (safeguard, reorganisation, liquidation, plans, closures), Spain from BORME insolvency acts.\nUse it for credit or supplier checks. Don't use it for sanctions: call screen_company.\nInputs: country and identifier, as lookup_company (e.g. 'FR', '441639465').\nReturns: state (in_procedure, under_plan, closed, notice_found, none_found, not_covered), procedure, dates, notices with official citations, covered_since.\nLimits: 1 unit. No notice outside the loaded years is not proof of no procedure. Read-only.",
    "inputSchema": {
      "properties": {
        "country": {
          "description": "ISO country code: FR or ES or GB.",
          "enum": [
            "FR",
            "ES",
            "GB"
          ],
          "examples": [
            "FR"
          ],
          "title": "Country",
          "type": "string"
        },
        "identifier": {
          "description": "Official ID, as lookup_company: FR SIREN (9 digits), SIRET or VAT; ES Registro Mercantil sheet, e.g. VI-23266. GB: Companies House company number, e.g. 00445790.",
          "examples": [
            "441639465",
            "VI-23266",
            "00445790"
          ],
          "maxLength": 64,
          "title": "Identifier",
          "type": "string"
        }
      },
      "required": [
        "country",
        "identifier"
      ],
      "type": "object",
      "title": "check_insolvencyArguments"
    }
  },
  {
    "name": "check_address",
    "title": "Validate a company's registered address",
    "description": "Validate a company's registered address against the official address base: France via API Adresse (Base Adresse Nationale, IGN).\nUse it to check that an address exists and is the company's, or to geolocate it. Don't use it to find companies: call search_companies.\nInputs: country and identifier, as lookup_company (e.g. 'FR', '441639465').\nReturns: validated (true, false or null with a reason), normalized address, BAN ids, coordinates, precision, confidence, and how many active companies share the address.\nLimits: 1 unit. Spain not available yet. Read-only.",
    "inputSchema": {
      "properties": {
        "country": {
          "description": "ISO country code: FR or ES or GB.",
          "enum": [
            "FR",
            "ES",
            "GB"
          ],
          "examples": [
            "FR"
          ],
          "title": "Country",
          "type": "string"
        },
        "identifier": {
          "description": "Official ID, as lookup_company: FR SIREN (9 digits), SIRET or VAT; ES Registro Mercantil sheet, e.g. VI-23266. GB: Companies House company number, e.g. 00445790.",
          "examples": [
            "441639465",
            "VI-23266",
            "00445790"
          ],
          "maxLength": 64,
          "title": "Identifier",
          "type": "string"
        }
      },
      "required": [
        "country",
        "identifier"
      ],
      "type": "object",
      "title": "check_addressArguments"
    }
  },
  {
    "name": "get_graph",
    "title": "A company's group: GLEIF parents and subsidiaries",
    "description": "Show a company's group: its parent and child companies from GLEIF (direct and ultimate parents), company to company, every edge with its source.\nUse it to map a company's group. Don't use it to look a company up: call resolve_company first for its entity_id.\nInputs: entity_id (e.g. 'fu_7K3M9Q2XH4PZ'), depth 1 or 2.\nReturns: nodes (companies), edges (from, kind parent_of, to, source, evidence), ownership (signals only; beneficial owners not covered), uncertainty.\nLimits: 2 units; API key required. No people, no director links. A company without an LEI shows no links. Read-only.",
    "inputSchema": {
      "properties": {
        "entity_id": {
          "description": "A Fuentio entity ID (from resolve_company).",
          "examples": [
            "fu_7K3M9Q2XH4PZ"
          ],
          "maxLength": 20,
          "title": "Entity Id",
          "type": "string"
        },
        "depth": {
          "default": 1,
          "description": "1 or 2.",
          "examples": [
            1
          ],
          "maximum": 2,
          "minimum": 1,
          "title": "Depth",
          "type": "integer"
        }
      },
      "required": [
        "entity_id"
      ],
      "type": "object",
      "title": "get_graphArguments"
    }
  },
  {
    "name": "report_issue",
    "title": "Report a wrong or missing answer",
    "description": "Report an answer you believe is wrong or missing, so Fuentio checks it against the official source.\nUse it when a result contradicts an official document you hold. Don't use it to ask questions: call the lookup tools.\nInputs: subject (entity ID, record ID such as 'FR-SIREN-441639465', or tool name), category (wrong_data, wrong_link, missing_data, wrong_status, other), message.\nReturns: issue_id, status 'open'.\nLimits: free; API key required; 20 reports per key per day.",
    "inputSchema": {
      "properties": {
        "subject": {
          "description": "Entity ID, record ID or tool name.",
          "examples": [
            "FR-SIREN-441639465"
          ],
          "maxLength": 80,
          "title": "Subject",
          "type": "string"
        },
        "category": {
          "enum": [
            "wrong_data",
            "wrong_link",
            "missing_data",
            "wrong_status",
            "other"
          ],
          "examples": [
            "wrong_status"
          ],
          "title": "Category",
          "type": "string"
        },
        "message": {
          "description": "What you expected and what you got.",
          "examples": [
            "Shown active, BODACC published a liquidation."
          ],
          "maxLength": 2000,
          "title": "Message",
          "type": "string"
        }
      },
      "required": [
        "subject",
        "category",
        "message"
      ],
      "type": "object",
      "title": "report_issueArguments"
    }
  },
  {
    "name": "get_evidence",
    "title": "The evidence behind a company's facts",
    "description": "Show the evidence behind what Fuentio says about a company: for each field, the value served and every competing value with its source, record, retrieval time, source link and record hash; and the match decision behind each link.\nUse it to justify an answer in a review or an audit. Don't use it to look a company up: call resolve_company first for its entity_id.\nInputs: entity_id (e.g. 'fu_7K3M9Q2XH4PZ'), optional field (name, status, address, legal_form, creation_date, activity), optional as_of 'YYYY-MM-DD'.\nReturns: evidence, links, decisions, uncertainty, how_to_check.\nLimits: 1 unit. Read-only.",
    "inputSchema": {
      "properties": {
        "entity_id": {
          "description": "A Fuentio entity ID (from resolve_company).",
          "examples": [
            "fu_7K3M9Q2XH4PZ"
          ],
          "maxLength": 20,
          "title": "Entity Id",
          "type": "string"
        },
        "field": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "One field, e.g. status.",
          "examples": [
            "status"
          ],
          "title": "Field"
        },
        "as_of": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "YYYY-MM-DD.",
          "examples": [
            null
          ],
          "title": "As Of"
        }
      },
      "required": [
        "entity_id"
      ],
      "type": "object",
      "title": "get_evidenceArguments"
    }
  },
  {
    "name": "check_vat",
    "title": "A company's EU VAT number (registration not checked)",
    "description": "Give a company's EU VAT number and how it was obtained. Registration is never checked: the answer links the official VIES page.\nUse it to fill an invoice or a supplier file. Don't use it as proof of VAT registration: check it on VIES.\nInputs: country and identifier, as lookup_company (e.g. 'FR', '441639465').\nReturns: number, origin (published or computed), registration_checked false, note, check_url.\nLimits: 1 unit. Spain: no VAT numbers published. Read-only.",
    "inputSchema": {
      "properties": {
        "country": {
          "description": "ISO country code: FR or ES or GB.",
          "enum": [
            "FR",
            "ES",
            "GB"
          ],
          "examples": [
            "FR"
          ],
          "title": "Country",
          "type": "string"
        },
        "identifier": {
          "description": "Official ID, as lookup_company: FR SIREN (9 digits), SIRET or VAT; ES Registro Mercantil sheet, e.g. VI-23266. GB: Companies House company number, e.g. 00445790.",
          "examples": [
            "441639465",
            "VI-23266",
            "00445790"
          ],
          "maxLength": 64,
          "title": "Identifier",
          "type": "string"
        }
      },
      "required": [
        "country",
        "identifier"
      ],
      "type": "object",
      "title": "check_vatArguments"
    }
  },
  {
    "name": "watch_company",
    "title": "Watch a company for changes (signed webhooks)",
    "description": "Watch a company: when its official records change, Fuentio POSTs the changes, signed, to your https endpoint.\nUse it to monitor a supplier or customer. Don't use it for a one-off check: call what_changed.\nInputs: entity_id (from resolve_company), callback_url (your https endpoint; private or local addresses are refused).\nReturns: watch_id, signing_secret (shown once) and how to verify each POST.\nLimits: 1 unit; API key required; free plan 3 watches.",
    "inputSchema": {
      "properties": {
        "entity_id": {
          "description": "A Fuentio entity ID (from resolve_company).",
          "examples": [
            "fu_7K3M9Q2XH4PZ"
          ],
          "maxLength": 20,
          "title": "Entity Id",
          "type": "string"
        },
        "callback_url": {
          "description": "Your https endpoint.",
          "examples": [
            "https://hooks.example.com/fuentio"
          ],
          "maxLength": 500,
          "title": "Callback Url",
          "type": "string"
        }
      },
      "required": [
        "entity_id",
        "callback_url"
      ],
      "type": "object",
      "title": "watch_companyArguments"
    }
  },
  {
    "name": "review_report",
    "title": "A review-ready report on a company",
    "description": "Produce one review-ready report on a company: identity and links with reasons, facts with sources, last year's changes and gaps, and every check at once (insolvency, sanctions, address, VAT, and in France the public contracts won).\nUse it for the registry part of a KYB or supplier review you must file (not full KYB: no UBO, PEP or adverse-media checks). Don't use it for one quick fact: call lookup_company.\nInputs: country and identifier, as lookup_company (e.g. 'FR', '441639465').\nReturns: company, facts, links, decisions, changes_last_year, modules, gaps, uncertainty, sha256, markdown.\nLimits: 8 units; API key required. Read-only.",
    "inputSchema": {
      "properties": {
        "country": {
          "description": "ISO country code: FR or ES or GB.",
          "enum": [
            "FR",
            "ES",
            "GB"
          ],
          "examples": [
            "FR"
          ],
          "title": "Country",
          "type": "string"
        },
        "identifier": {
          "description": "Official ID, as lookup_company: FR SIREN (9 digits), SIRET or VAT; ES Registro Mercantil sheet, e.g. VI-23266. GB: Companies House company number, e.g. 00445790.",
          "examples": [
            "441639465",
            "VI-23266",
            "00445790"
          ],
          "maxLength": 64,
          "title": "Identifier",
          "type": "string"
        }
      },
      "required": [
        "country",
        "identifier"
      ],
      "type": "object",
      "title": "review_reportArguments"
    }
  },
  {
    "name": "check_supplier_list",
    "title": "Check a supplier list (registry check)",
    "description": "Check a supplier list against the official registers: which suppliers are ok, which need a look and why (e.g. in liquidation since a date, per BODACC), with a proof code each, and a private report link to share.\nUse it for 2 to 100 suppliers at once, or to read a batch you started. Don't use it for one company: call verify_company.\nInputs: rows [{reference, company_name, country, identifier}] (an official ID is best; a name alone counts only with postal_code and street matching one company), or batch_id.\nReturns: counts by review_state (ok, review, could_not_confirm, not_covered, error), the review rows with reasons, share_url; 'next' when still checking.\nLimits: 5 units a row (+2 for a name), checks reused 24 h free. A registry check, not KYB or sanctions clearance; no person's name.",
    "inputSchema": {
      "properties": {
        "rows": {
          "anyOf": [
            {
              "items": {
                "$ref": "#/$defs/SupplierRow"
              },
              "maxItems": 100,
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "Up to 100 suppliers. Leave out to read a batch_id.",
          "title": "Rows"
        },
        "batch_id": {
          "anyOf": [
            {
              "maxLength": 40,
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "A batch this key started, e.g. sb_3Kq9…",
          "title": "Batch Id"
        }
      },
      "type": "object",
      "$defs": {
        "SupplierRow": {
          "additionalProperties": false,
          "description": "One supplier for check_supplier_list (brief 011 A7): an official ID is best; a name alone\ncounts only with the postcode and street of one company.",
          "properties": {
            "reference": {
              "anyOf": [
                {
                  "maxLength": 200,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "description": "Your supplier ID.",
              "title": "Reference"
            },
            "company_name": {
              "anyOf": [
                {
                  "maxLength": 300,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "examples": [
                "RENAULT"
              ],
              "title": "Company Name"
            },
            "country": {
              "description": "FR, ES or GB.",
              "examples": [
                "FR"
              ],
              "maxLength": 60,
              "title": "Country",
              "type": "string"
            },
            "identifier_type": {
              "anyOf": [
                {
                  "maxLength": 40,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "examples": [
                "SIREN"
              ],
              "title": "Identifier Type"
            },
            "identifier": {
              "anyOf": [
                {
                  "maxLength": 60,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "examples": [
                "441639465"
              ],
              "title": "Identifier"
            },
            "postal_code": {
              "anyOf": [
                {
                  "maxLength": 20,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "title": "Postal Code"
            },
            "town": {
              "anyOf": [
                {
                  "maxLength": 100,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "title": "Town"
            },
            "street": {
              "anyOf": [
                {
                  "maxLength": 200,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "title": "Street"
            }
          },
          "required": [
            "country"
          ],
          "title": "SupplierRow",
          "type": "object"
        }
      },
      "title": "check_supplier_listArguments"
    }
  },
  {
    "name": "list_coverage",
    "title": "List covered countries and ID formats",
    "description": "List the countries, ID formats and official sources Fuentio covers. Free, no key.\nUse it first when unsure whether a country or ID format is supported, or to explain coverage. Don't use it to check a company: call lookup_company or search_companies.\nInputs: none. Example: list_coverage().\nReturns: per country, status (available or planned), coverage level, ID formats with real examples and whether lookup works, regional registers, and sources with licence and update frequency.\nLimits: 0 units. Read-only. Covered today: France, Spain and United Kingdom.\nSearch words: company registry, KYB, SIREN, RCS, Annuaire des Entreprises, société; BORME, Registro Mercantil, empresa, sociedad; Companies House, company number, Ltd, plc, LLP.",
    "inputSchema": {
      "properties": {},
      "type": "object",
      "title": "list_coverageArguments"
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` is one of the captured tools. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `firmproof error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Parse a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * one is present, else the last parseable message, else
 * null when nothing parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not JSON; ignore this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding one upstream session. The
 * session is established lazily on the first forwarded
 * call and reused for the lifetime of the client (the
 * process lifetime when the client is the MCP server's
 * or a one-shot client for the CLI).
 */
export class FirmproofClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).FUENTIO_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private apiKey(): string | null {
    const raw = (this.deps.env ?? process.env).FUENTIO_API_KEY;
    if (raw && raw.trim() !== "") return raw.trim();
    return null;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const key = this.apiKey();
    if (key !== null) headers["X-API-Key"] = key;
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "firmproof", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // The notification response body carries nothing we need.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Pass the upstream result through verbatim.
    return result;
  }
}

/** Create a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): FirmproofClient {
  return new FirmproofClient(deps);
}

/** One-shot helper: a fresh client per call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new FirmproofClient(deps).callTool(name, args);
}
