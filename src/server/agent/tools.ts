import { chromium, type Browser, type Page } from "playwright"
import Steel from "steel-sdk"
import { searchParallel } from "./parallel-search.js"

export type SearchProvider = "duckduckgo" | "parallel"

export function parseSearchProvider(value?: string): SearchProvider {
	if (!value || value === "duckduckgo") return "duckduckgo"
	if (value === "parallel") return "parallel"
	throw new Error("SEARCH_PROVIDER must be duckduckgo or parallel")
}

export interface BrowserSession {
	steel_client: Steel
	session: Steel.Session
	browser: Browser
	page: Page
}

export async function createBrowserSession(
	steel_api_key: string,
): Promise<BrowserSession> {
	const steel_client = new Steel({ steelAPIKey: steel_api_key })

	const session = await steel_client.sessions.create({
		timeout: 600000,
	})

	const browser = await chromium.connectOverCDP(
		`${session.websocketUrl}&apiKey=${steel_api_key}`,
	)

	const context = browser.contexts()[0]
	const page = context.pages()[0]

	return { steel_client, session, browser, page }
}

export async function releaseBrowserSession(
	bs: BrowserSession,
): Promise<void> {
	try {
		await bs.browser.close()
	} catch {
		// browser may already be closed
	}
	await bs.steel_client.sessions.release(bs.session.id)
}

export async function searchGoogle(
	bs: BrowserSession,
	query: string,
): Promise<string> {
	// Use DuckDuckGo HTML version -- much less bot detection than Google
	const encoded_query = encodeURIComponent(query)
	await bs.page.goto(
		`https://html.duckduckgo.com/html/?q=${encoded_query}`,
		{ waitUntil: "domcontentloaded", timeout: 15000 },
	)

	const results = await bs.page.evaluate(() => {
		const items: { title: string; url: string; snippet: string }[] = []
		const elements = document.querySelectorAll(".result")

		for (let i = 0; i < Math.min(elements.length, 10); i++) {
			const el = elements[i]
			const link = el.querySelector("a.result__a") as HTMLAnchorElement | null
			const snippet_el = el.querySelector(".result__snippet")

			if (link) {
				items.push({
					title: link.textContent?.trim() || "",
					url: link.href || "",
					snippet: snippet_el?.textContent?.trim() || "",
				})
			}
		}
		return items
	})

	const filtered = results.filter(r => !isBlockedUrl(r.url))

	if (filtered.length === 0) {
		return "No search results found. Try a different query."
	}

	return filtered
		.map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`)
		.join("\n\n")
}

export async function searchWeb(
	bs: BrowserSession,
	query: string,
	provider: SearchProvider = "duckduckgo",
	signal?: AbortSignal,
): Promise<string> {
	if (provider === "parallel") {
		return searchParallel(query, bs.session.id, { signal })
	}
	return searchGoogle(bs, query)
}

const BLOCKED_DOMAINS = ["google.com", "google.co", "googleapis.com", "gstatic.com"]

function isBlockedUrl(url: string): boolean {
	try {
		const hostname = new URL(url).hostname
		return BLOCKED_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))
	} catch {
		return false
	}
}

export async function visitPage(
	bs: BrowserSession,
	url: string,
): Promise<string> {
	if (isBlockedUrl(url)) {
		return "This URL is on a blocked domain (Google). Google blocks cloud browser IPs. Please use a different source for this information."
	}

	try {
		const result = await bs.steel_client.scrape({
			url,
			format: ["markdown"],
		})

		const markdown = result.content?.markdown || ""

		if (!markdown) {
			return "Page content could not be extracted."
		}

		const max_length = 4000
		if (markdown.length > max_length) {
			return markdown.slice(0, max_length) + "\n\n[Content truncated...]"
		}

		return markdown
	} catch {
		try {
			await bs.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 })
			const text = await bs.page.evaluate(() => {
				const body = document.body
				body.querySelectorAll("script, style, nav, footer, header").forEach(
					(el) => el.remove(),
				)
				return body.innerText.slice(0, 4000)
			})
			return text || "Page content could not be extracted."
		} catch {
			return "Failed to load page. It may be blocked or unavailable."
		}
	}
}
