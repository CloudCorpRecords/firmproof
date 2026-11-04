import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  FirmproofClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream
 * implementing the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, no live call — the real Fuentio
 * endpoint is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/fuentio-company-data-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};

/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"ok\":true}" }],
  structuredContent: { ok: true },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "fuentio", version: "1.1.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new FirmproofClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

const EXPECTED_NAMES = [
  "lookup_company",
  "search_companies",
  "get_company_history",
  "verify_company",
  "get_receipt",
  "resolve_company",
  "explain_match",
  "what_changed",
  "screen_company",
  "check_insolvency",
  "check_address",
  "get_graph",
  "report_issue",
  "get_evidence",
  "check_vat",
  "watch_company",
  "review_report",
  "check_supplier_list",
  "list_coverage",
];

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 19 tools, deep-equal", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 19);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 19 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, EXPECTED_NAMES);
  });

  it("carries exactly the fixture's required fields per tool", () => {
    const required = new Map(
      TOOL_DEFS.map((t) => [
        t.name,
        (t.inputSchema as { required?: string[] }).required ?? [],
      ]),
    );
    assert.deepEqual(required.get("lookup_company"), ["country", "identifier"]);
    assert.deepEqual(required.get("search_companies"), ["query", "country"]);
    assert.deepEqual(required.get("get_company_history"), ["country", "identifier"]);
    assert.deepEqual(required.get("verify_company"), ["country", "identifier"]);
    assert.deepEqual(required.get("get_receipt"), ["proof_code", "format"]);
    assert.deepEqual(required.get("resolve_company"), ["country"]);
    assert.deepEqual(required.get("explain_match"), ["left", "right"]);
    assert.deepEqual(required.get("what_changed"), ["entity_id", "since"]);
    assert.deepEqual(required.get("screen_company"), ["country", "identifier"]);
    assert.deepEqual(required.get("check_insolvency"), ["country", "identifier"]);
    assert.deepEqual(required.get("check_address"), ["country", "identifier"]);
    assert.deepEqual(required.get("get_graph"), ["entity_id"]);
    assert.deepEqual(required.get("report_issue"), ["subject", "category", "message"]);
    assert.deepEqual(required.get("get_evidence"), ["entity_id"]);
    assert.deepEqual(required.get("check_vat"), ["country", "identifier"]);
    assert.deepEqual(required.get("watch_company"), ["entity_id", "callback_url"]);
    assert.deepEqual(required.get("review_report"), ["country", "identifier"]);
    assert.deepEqual(required.get("check_supplier_list"), []);
    assert.deepEqual(required.get("list_coverage"), []);
  });

  it("serves no required key at all for check_supplier_list and list_coverage", () => {
    for (const name of ["check_supplier_list", "list_coverage"]) {
      const def = TOOL_DEFS.find((t) => t.name === name);
      assert.ok(def !== undefined);
      assert.equal("required" in (def.inputSchema as object), false);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://api.fuentio.com/mcp");

    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, {
      name: "firmproof",
      version: VERSION,
    });
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(
        call.headers["Accept"],
        "application/json, text/event-stream",
      );
    }
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    await c.callTool("list_coverage", {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool("list_coverage", {});
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the FUENTIO_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new FirmproofClient({
      fetchFn: upstream.fetchFn,
      env: { FUENTIO_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool("list_coverage", {});
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool("list_coverage", {});
    assert.ok(
      upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends X-API-Key on every request when FUENTIO_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new FirmproofClient({
      fetchFn: upstream.fetchFn,
      env: { FUENTIO_API_KEY: "fuentio-key-42" },
    });
    await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every(
        (call) => call.headers["X-API-Key"] === "fuentio-key-42",
      ),
    );
  });

  it("sends no X-API-Key header when FUENTIO_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.ok(calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("never sends an Authorization header, with or without a key", async () => {
    const withKey = makeUpstream();
    const c1 = new FirmproofClient({
      fetchFn: withKey.fetchFn,
      env: { FUENTIO_API_KEY: "fuentio-key-42" },
    });
    await c1.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.ok(
      withKey.calls.every((call) => call.headers["Authorization"] === undefined),
    );
    const { client: c2, calls } = stubClient();
    await c2.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards lookup_company arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { country: "FR", identifier: "441639465", format: "csv" };
    await c.callTool("lookup_company", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "lookup_company");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards get_receipt with its proof code and format", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("get_receipt", { proof_code: "FUE-FR-20261015-DZ7TP9", format: "normal" });
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "get_receipt");
    assert.deepEqual(params.arguments, { proof_code: "FUE-FR-20261015-DZ7TP9", format: "normal" });
  });

  it("forwards watch_company with entity_id and callback_url", async () => {
    const { client: c, calls } = stubClient();
    const args = { entity_id: "fu_7K3M9Q2XH4PZ", callback_url: "https://hooks.example.com/fuentio" };
    await c.callTool("watch_company", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "watch_company");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards check_supplier_list rows verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { rows: [{ reference: "s1", country: "FR", identifier: "441639465" }] };
    await c.callTool("check_supplier_list", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "check_supplier_list");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards list_coverage with an empty arguments object", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("list_coverage", {});
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "list_coverage");
    assert.deepEqual(params.arguments, {});
  });

  for (const name of EXPECTED_NAMES) {
    it(`forwards ${name} under its own tool name`, async () => {
      const { client: c, calls } = stubClient();
      await c.callTool(name, { probe: name });
      const params = calls[2].body.params as Record<string, unknown>;
      assert.equal(params.name, name);
      assert.deepEqual(params.arguments, { probe: name });
    });
  }

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "company not found" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool("lookup_company", { country: "FR", identifier: "000000000" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool("list_coverage", {});
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      "check_vat",
      { country: "FR", identifier: "441639465" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "check_vat");
    assert.deepEqual(params.arguments, { country: "FR", identifier: "441639465" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as firmproof error text", () => {
  it("maps a JSON-RPC error to `firmproof error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "company not found" },
    });
    const out = await c.callTool("lookup_company", { country: "FR", identifier: "000000000" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "firmproof error: company not found");
  });

  it("maps an initialize JSON-RPC error to firmproof error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "firmproof error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "firmproof error: malformed response");
  });

  it("maps a non-2xx upstream status to firmproof error text", async () => {
    const { client: c } = stubClient({
      callBodyText: "internal error",
      callStatus: 500,
    });
    const out = await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "firmproof error: HTTP 500");
  });

  it("maps a throwing fetch to firmproof error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^firmproof error: /);
  });

  it("maps a throwing initialize fetch to firmproof error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "firmproof error: socket hang up");
  });

  it("maps a timed-out call to firmproof error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool("lookup_company", { country: "FR", identifier: "441639465" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^firmproof error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects non-object arguments before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "lookup_company", ["nope"]),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, "verify_company", { country: "FR", identifier: "441639465" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { country: "FR", identifier: "441639465" });
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli(["lookup_company", "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli(["lookup_company", "[]"]);
    assert.equal(res.status, 2);
  });
});
