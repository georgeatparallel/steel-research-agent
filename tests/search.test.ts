import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import Anthropic from "@anthropic-ai/sdk"
import Steel from "steel-sdk"
import { chromium } from "playwright"
import Fastify from "fastify"
import { searchParallel } from "../src/server/agent/parallel-search.js"
import { parseSearchProvider, searchWeb, type BrowserSession } from "../src/server/agent/tools.js"
import { registerResearchRoute } from "../src/server/routes/research.js"

const query = "Steel browser automation documentation"
const session_id = "c1abe716-10e1-4986-bb78-809116af8410"
const result_text = "1. **Steel docs**\n   URL: https://docs.steel.dev/\n   Cloud browsers for agents."

// Keep the real MCP client and transport. Replace only the network boundary.
function mcpNetwork(t: TestContext, call: (body: any, init: RequestInit) => Response | Promise<Response>) {
	const requests: any[] = []
	t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
		assert.equal(String(url), "https://search.parallel.ai/mcp")
		const headers = new Headers(init.headers)
		assert.equal(headers.get("user-agent"), "steel-research-agent/1.0.0")
		assert.equal(headers.get("authorization"), null)
		assert.ok(init.signal)
		if (init.method === "GET") return new Response(null, { status: 405 })
		const body = JSON.parse(init.body as string)
		requests.push(body)
		if (body.method === "initialize") {
			return Response.json({ jsonrpc: "2.0", id: body.id, result: {
				protocolVersion: body.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1.0.0" },
			} })
		}
		if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 })
		assert.equal(body.method, "tools/call")
		return call(body, init)
	})
	return requests
}

function success(body: any, text = result_text) {
	return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } })
}

test("provider selection preserves browser search and rejects unknown configuration", async (t) => {
	assert.equal(parseSearchProvider(), "duckduckgo")
	assert.equal(parseSearchProvider(""), "duckduckgo")
	assert.equal(parseSearchProvider("duckduckgo"), "duckduckgo")
	assert.equal(parseSearchProvider("parallel"), "parallel")
	assert.throws(() => parseSearchProvider("typo"), /SEARCH_PROVIDER/)
	t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request") })
	const visits: string[] = []
	const bs = { page: {
		goto: async (url: string) => { visits.push(url) },
		evaluate: async () => [
			{ title: "Steel docs", url: "https://docs.steel.dev/", snippet: "Cloud browsers" },
			{ title: "Blocked", url: "https://www.google.com/", snippet: "Hidden" },
		],
	} } as unknown as BrowserSession
	for (const provider of [undefined, "duckduckgo"] as const) {
		const result = await searchWeb(bs, query, provider)
		assert.match(result, /URL: https:\/\/docs.steel.dev\//)
		assert.doesNotMatch(result, /Blocked/)
	}
	assert.deepEqual(visits, Array(2).fill(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`))
})

test("Parallel dispatch sends the current tool schema and consumes JSON results", async (t) => {
	const requests = mcpNetwork(t, (body) => success(body))
	const bs = { session: { id: session_id } } as BrowserSession
	assert.equal(await searchWeb(bs, query, "parallel"), result_text)
	const call = requests.find((r) => r.method === "tools/call")
	assert.equal(call.params.name, "web_search")
	assert.deepEqual(call.params.arguments, {
		objective: query, search_queries: [query], session_id, model_name: "claude-sonnet-4-6",
	})
})

test("Parallel accepts a Streamable HTTP SSE response", async (t) => {
	mcpNetwork(t, (body) => new Response(`event: message\ndata: ${JSON.stringify({
		jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: result_text }] },
	})}\n\n`, { headers: { "Content-Type": "text/event-stream" } }))
	assert.equal(await searchParallel(query, session_id), result_text)
})

test("Parallel tool errors, empty content, malformed payloads and HTTP failures propagate", async (t) => {
	for (const [name, response, expected] of [
		["tool error", (body: any) => Response.json({ jsonrpc: "2.0", id: body.id, result: {
			isError: true, content: [{ type: "text", text: "Rate limit exceeded" }],
		} }), /Parallel search failed: Rate limit exceeded/],
		["empty", (body: any) => success(body, ""), /no text results/],
		["malformed", () => new Response("not json", { headers: { "Content-Type": "application/json" } }), /JSON|Unexpected token/],
		["HTTP failure", () => new Response("Unavailable", { status: 503 }), /503|Unavailable/],
	] as const) {
		await t.test(name, async (t) => {
			const requests = mcpNetwork(t, response)
			await assert.rejects(searchParallel(query, session_id), expected)
			assert.equal(requests.filter((r) => r.method === "tools/call").length, 1)
		})
	}
})

function waitForAbort(init: RequestInit): Promise<Response> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(new Response(null, { status: 500 })), 5000)
		const abort = () => { clearTimeout(timer); reject(init.signal!.reason) }
		if (init.signal!.aborted) abort()
		else init.signal!.addEventListener("abort", abort, { once: true })
	})
}

test("deadline and caller cancellation abort in-flight requests", async (t) => {
	await t.test("deadline", async (t) => {
		mcpNetwork(t, (_body, init) => waitForAbort(init))
		await assert.rejects(searchParallel(query, session_id, { timeoutMs: 30 }), /Timeout|aborted/)
	})
	await t.test("cancel during tool execution", async (t) => {
		const controller = new AbortController()
		mcpNetwork(t, (_body, init) => {
			queueMicrotask(() => controller.abort(new Error("Research cancelled")))
			return waitForAbort(init)
		})
		await assert.rejects(searchParallel(query, session_id, { signal: controller.signal }), /Research cancelled/)
	})
	await t.test("already cancelled", async (t) => {
		t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected request") })
		await assert.rejects(searchParallel(query, session_id, { signal: AbortSignal.abort() }), /aborted/)
	})
	await t.test("deadline includes initialization", async (t) => {
		t.mock.method(globalThis, "fetch", (_url: URL, init: RequestInit) => waitForAbort(init))
		await assert.rejects(searchParallel(query, session_id, { timeoutMs: 30 }), /Timeout|aborted/)
	})
})

test("configured HTTP route dispatches Parallel results into the research loop and releases Steel", async (t) => {
	const saved_env = { ...process.env }
	t.after(() => { process.env = saved_env })
	process.env.STEEL_API_KEY = "fixture-steel-key"
	process.env.ANTHROPIC_API_KEY = "fixture-anthropic-key"
	process.env.SEARCH_PROVIDER = "parallel"
	// Saved credentials are not used: Parallel requests must remain anonymous.
	process.env.PARALLEL_API_KEY = "must-not-be-sent"
	let fail_search = false
	const requests = mcpNetwork(t, (body) => fail_search
		? new Response("Search unavailable", { status: 503 })
		: success(body))
	const steel = new Steel({ steelAPIKey: "fixture" })
	t.mock.method(Object.getPrototypeOf(steel.sessions), "create", async () => ({
		id: session_id, websocketUrl: "wss://fixture.invalid?session=1",
		sessionViewerUrl: "https://fixture.invalid/viewer", debugUrl: "https://fixture.invalid/debug",
	}))
	const release = t.mock.method(Object.getPrototypeOf(steel.sessions), "release", async (id: string) => {
		assert.equal(id, session_id)
	})
	let closed = false
	t.mock.method(chromium, "connectOverCDP", async () => ({
		contexts: () => [{ pages: () => [{}] }], close: async () => { closed = true },
	}))
	const anthropic = new Anthropic({ apiKey: "fixture" })
	let rounds = 0
	t.mock.method(Object.getPrototypeOf(anthropic.messages), "create", async (params: any) => {
		if (rounds++ === 0) return { content: [1, 2].map((id) => ({
			type: "tool_use", id: `search-${id}`, name: "search_google", input: { query },
		})) }
		const results = params.messages.at(-1).content
		assert.equal(results.length, 2)
		assert.ok(results.every((r: any) => r.content === result_text))
		return { content: [{ type: "tool_use", id: "finish", name: "finish_research", input: {
			report: "Steel offers cloud browsers [1].", sources: [{ title: "Steel docs", url: "https://docs.steel.dev/" }],
		} }] }
	})
	const app = Fastify()
	t.after(() => app.close())
	await registerResearchRoute(app)
	const response = await app.inject({ method: "POST", url: "/api/research", payload: { question: query } })
	assert.equal(response.statusCode, 200)
	assert.match(response.body, /report_ready/)
	assert.match(response.body, /Steel offers cloud browsers/)
	assert.equal(requests.filter((r) => r.method === "tools/call").length, 2)
	assert.ok(requests.filter((r) => r.method === "tools/call").every((r) => r.params.arguments.session_id === session_id))
	assert.equal(release.mock.callCount(), 1)
	assert.equal(closed, true)

	process.env.SEARCH_PROVIDER = "typo"
	const invalid = await app.inject({ method: "POST", url: "/api/research", payload: { question: query } })
	assert.equal(invalid.statusCode, 500)
	assert.match(invalid.body, /SEARCH_PROVIDER/)
	assert.equal(release.mock.callCount(), 1)

	process.env.SEARCH_PROVIDER = "parallel"
	fail_search = true
	rounds = 0
	const failed = await app.inject({ method: "POST", url: "/api/research", payload: { question: query } })
	assert.match(failed.body, /"type":"error"/)
	assert.doesNotMatch(failed.body, /report_ready/)
	assert.equal(release.mock.callCount(), 2)
})
