# Steel Research Agent

AI-powered deep web research using [Steel's](https://steel.dev) cloud browser infrastructure. Ask a question, watch an AI agent browse the web in real-time, and get a comprehensive research report with cited sources.

![Agent researching with live browser view](https://github.com/user-attachments/assets/2d4fbd99-cafb-4c7b-a279-2704114179bc)

![Research report with cited sources](https://github.com/user-attachments/assets/1fc7d222-779b-476f-9622-e2fe1f5cf911)

## Features

- **Live Browser View** -- Watch the AI agent navigate, search, and read web pages in real-time via Steel's session embedding
- **Claude-Powered Research** -- Uses Claude's tool-use API to autonomously decide what to search, which pages to read, and when to synthesize findings
- **Cited Reports** -- Every claim in the final report is backed by numbered source citations
- **Real-Time Activity Feed** -- See the agent's thought process and progress as it works
- **Research History** -- IndexedDB-backed sidebar to revisit past research sessions
- **Responsive Design** -- Fully responsive UI that works on desktop, tablet, and mobile

## Architecture

```mermaid
flowchart TB
    subgraph Client["Frontend (React + Vite)"]
        UI[Research Input]
        Feed[Activity Feed]
        Browser[Live Browser View]
        Report[Report View]
        History[History Sidebar]
    end

    subgraph Server["Backend (Fastify)"]
        API["/api/research (SSE)"]
        Agent[Research Agent Loop]
        Proxy["/api/sessions/:id/recording"]
    end

    subgraph External["External Services"]
        Claude[Claude API]
        Steel[Steel Sessions API]
        Scrape[Steel Scrape API]
        PW[Playwright CDP]
    end


    UI -->|POST + SSE stream| API
    API --> Agent
    Agent -->|tool calls| Claude
    Agent -->|create session| Steel
    Agent -->|search & navigate| PW
    Agent -->|extract content| Scrape
    Agent -->|progress events| Feed
    Steel -->|debugUrl iframe| Browser
    Agent -->|report_ready| Report
    History -->|IndexedDB| UI
    Proxy -->|HLS proxy| Steel
```

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant S as Fastify Server
    participant C as Claude API
    participant B as Steel Browser

    U->>F: Enter research question
    F->>S: POST /api/research (SSE)
    S->>B: Create browser session
    B-->>F: debugUrl (live iframe)

    loop Research Loop (max 10 iterations)
        S->>C: messages + tools
        C-->>S: tool_use (search_google)
        S->>B: DuckDuckGo search
        B-->>S: Search results
        S-->>F: SSE: searching event

        C-->>S: tool_use (visit_page x3 parallel)
        S->>B: Scrape 3 pages in parallel
        B-->>S: Markdown content
        S-->>F: SSE: visiting/reading events

        C-->>S: tool_use (finish_research)
        S-->>F: SSE: report_ready
    end

    S->>B: Release session
    F->>F: Save to IndexedDB history
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Tailwind CSS v4, Vite 7 |
| Backend | Fastify 5, TypeScript 5.9 |
| AI | Claude Sonnet 4.6 (Anthropic SDK) |
| Browser | Steel SDK, Playwright (CDP) |
| Infrastructure | Docker |
| Realtime | Server-Sent Events (SSE) |
| Storage | IndexedDB (client-side history) |
| Streaming | HLS.js (session recording) |
| Markdown | react-markdown, remark-gfm |

## Steel Features Used

- **Sessions API** -- Create and manage cloud browser instances
- **Session Embedding** -- Live iframe view of the browser via `debugUrl`
- **Scrape API** -- Extract page content as clean markdown
- **Playwright Integration** -- Full browser control via CDP WebSocket

## Setup

### Local Development

```bash
# Clone and install
git clone https://github.com/Ray0907/steel-research-agent.git
cd steel-research-agent
pnpm install

# Configure API keys
cp .env.example .env
# Edit .env with your STEEL_API_KEY and ANTHROPIC_API_KEY

# Run development servers
pnpm dev
```

### Docker

```bash
# Configure API keys
cp .env.example .env

# Build and run
docker compose up --build
```

The app will be available at http://localhost:3001.

Get your Steel API key at [app.steel.dev](https://app.steel.dev/settings/api-keys).

### Optional Parallel search

Set `SEARCH_PROVIDER=parallel` in `.env` and restart the server to discover sources
with [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp).
It provides free web search in Fast mode without a Parallel account or API key,
subject to the anonymous service's rate limits. Searches send the query to
`https://search.parallel.ai/mcp` over Streamable HTTP.

Steel still reads the selected pages and provides the browser session, so both
`STEEL_API_KEY` and `ANTHROPIC_API_KEY` remain required. Parallel searches happen
outside the browser and do not appear in the live browser view. Search failures
are reported through the existing error feed; they do not switch providers.

Leave `SEARCH_PROVIDER` unset or set it to `duckduckgo` to keep the original
browser-based search. Other values are rejected before research starts. This
setting works with both local development and Docker's existing `.env` setup.

## Usage

1. Open http://localhost:5173
2. Enter a research question
3. Watch the AI agent browse the web in the live browser panel
4. Follow the agent's progress in the activity feed
5. Read the final research report with citations
6. Access past research from the history sidebar

## CLI Testing

Run the provider and transport tests without API keys:

```bash
pnpm test
```

To exercise a complete research session with your Steel and Anthropic keys:

```bash
# Start the server
pnpm dev:server

# In another terminal
pnpm test:cli "What are the top browser automation frameworks for AI agents?"
```
