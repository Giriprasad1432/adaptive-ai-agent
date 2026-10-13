# Adaptive AI Agent & StudyPilot

An autonomous reasoning agent backend built with Node.js (ES Modules), Express, the Model Context Protocol (MCP), and local LLMs via Ollama.

The primary showcase application is **StudyPilot**, an adaptive study planner that dynamically adjusts schedules and milestones based on actual study habits, recorded sessions, and missed commitments.

---

## Architecture Overview

```text
adaptive-ai-agent/
├── src/
│   ├── server.js                   # Express application entrypoint (/api/health, /api/tools, /api/chat)
│   ├── agent/                      # Core agent reasoning & execution loop
│   │   ├── adaptiveAgent.js        # Bounded multi-round loop with tool invocation & error handling
│   │   ├── validator.js            # Input schema & parameter validation
│   │   ├── prompts.js              # Ground-truth operational rules & system prompt
│   │   └── index.js                # Agent factory & exports
│   ├── providers/                  # Extensible LLM provider abstraction (Ollama, Groq ready)
│   │   ├── baseProvider.js         # Abstract provider contract
│   │   ├── ollamaProvider.js       # Local Ollama client & tool-calling adapter
│   │   └── index.js                # Provider registry & factory
│   └── mcp/                        # MCP Client integration layer
│       ├── mcpClient.js            # StdioClientTransport & Client manager via official SDK
│       └── index.js                # Singleton client accessor & exports
├── studypilot-server/              # StudyPilot MCP Server
│   ├── server.js                   # MCP server registering StudyPilot tools
│   ├── planner.js                  # Study planning & schedule adaptation algorithms
│   ├── storage.js                  # Local persistent JSON storage
│   ├── package.json
│   └── data/                       # JSON plan storage
├── test/
│   └── studypilot_mcp.test.js      # Deterministic end-to-end integration tests
├── .env.example                    # Configuration template
├── .gitignore                      # Secrets & build artifact ignore rules
├── package.json
└── readme.md
```

---

## StudyPilot MCP Tools

The StudyPilot MCP server exposes 5 tools via the official `@modelcontextprotocol/sdk`:

1. **`list_study_plans`**
   - **Description**: Lists saved plans by subject and goal so users can select a plan without remembering internal IDs.
   - **Parameters**: None.

2. **`create_study_plan`**
   - **Description**: Generates an initial priority-weighted study schedule from a subject list, exam date, daily available hours, and optional subject priorities (`high`, `medium`, `low`).
   - **Parameters**: `subjects` (array/string), `examDate` (YYYY-MM-DD), `dailyAvailableHours` (number), `priorities` (object, optional), `planId` (string, optional).

3. **`get_study_plan`**
   - **Description**: Retrieves the saved study plan, showing total completed hours, missed hours, remaining workload, progress percentage, and recent session logs.
   - **Parameters**: `planId` (string, optional in the tool schema). StudyPilot resolves an explicit ID, the active conversation's verified plan, or an unambiguous saved-plan selection; it never silently defaults to another plan.

4. **`record_study_session`**
   - **Description**: Records a completed, partially completed, or missed session. Updates subject progress and logs missed hours if a session was skipped.
   - **Parameters**: `subject` (string), `hoursSpent` (number), `status` (`completed` | `partially_completed` | `missed`), `notes` (string, optional), `date` (YYYY-MM-DD, optional), `planId` (string, optional in the schema; resolved safely from the active conversation or a verified saved plan).

5. **`adapt_study_plan`**
   - **Description**: Re-evaluates remaining days until the exam, recalculates subject hour allocations, prioritizes backlog recovery from missed sessions, and warns if the remaining workload requires increasing daily study hours.
   - **Parameters**: `planId` (string, optional in the schema; never defaults to another plan), `reason` (string, optional), `newExamDate` (YYYY-MM-DD, optional), `newDailyAvailableHours` (number, optional).

---

## Getting Started

### Prerequisites

1. **Node.js**: v18+ (tested on Node.js v22)
2. **An AI provider**: Ollama with `llama3.2`, or Groq with a valid API key:
   ```bash
   ollama pull llama3.2
   ```

### Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Example local Ollama configuration in `.env` (the project also supports `AI_PROVIDER=groq` with `GROQ_API_KEY` set):

```env
PORT=3000
AI_PROVIDER=ollama
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2

# Primary Application: StudyPilot MCP Server
MCP_SERVER_COMMAND=node
MCP_SERVER_ARGS=./studypilot-server/server.js

# Optional Development Alternative (Calculator MCP Server):
# MCP_SERVER_ARGS=../mcp-server/server.js

MAX_AGENT_ROUNDS=6
```

### Running the Backend

- **Development mode** (with nodemon):
  ```bash
  npm run dev
  ```
- **Production mode**:
  ```bash
  npm start
  ```

---

## Running the Deterministic Test Suite

To verify real MCP tool execution end-to-end without needing Ollama:

```bash
npm test
```

This test:
1. Connects a real MCP client via `StdioClientTransport` to `studypilot-server/server.js`.
2. Discovers and asserts all 5 StudyPilot tools.
3. Creates a study plan (`Mathematics` [high], `Physics` [medium], `Chemistry` [low]).
4. Retrieves the created plan and verifies allocations.
5. Records a completed session for Chemistry.
6. Records a missed session for Mathematics.
7. Executes `adapt_study_plan` and verifies that backlog is factored into remaining hours and recommended daily study pace.
8. Retrieves the final adapted plan and verifies the adaptation history log.

---

## API Endpoints

### 1. Health Status
`GET /api/health`

Returns server status, AI provider status, model installation status, and connected MCP server info.

### 2. Discovered Tools
`GET /api/tools`

Returns the list of active tools and their JSON schemas from the connected MCP server.

### 3. Agent Reasoning & Tool Invocation
`POST /api/chat`

Body:
```json
{
  "message": "Create a study plan for Mathematics and Physics with exam on 2026-12-15 and 3 daily available hours. Set Mathematics as high priority."
}
```

Response:
```json
{
  "reply": "I have created your study plan for Mathematics and Physics...",
  "success": true,
  "rounds": 2,
  "steps": [...]
}
```

---

## Phase 4 Readiness: Sample React Frontend

The React + Vite client lives in `frontend/` and remains a thin client of the existing Express API.

### Start commands

Start Ollama and pull the configured model once:

```powershell
ollama pull llama3.2
ollama serve
```

With the current `.env` configured for Stdio MCP, start the backend from the repository root:

```powershell
npm install
npm start
```

The API listens on `http://localhost:3000` by default. For local Ollama, set `AI_PROVIDER=ollama`, `OLLAMA_HOST=http://127.0.0.1:11434`, and `OLLAMA_MODEL=llama3.2`; for Groq, set `AI_PROVIDER=groq` and provide a valid `GROQ_API_KEY`. MCP defaults to Stdio with `MCP_SERVER_COMMAND=node` and `MCP_SERVER_ARGS=./studypilot-server/server.js`. `PORT` changes the Express API port. Standalone MCP HTTP mode uses `MCP_TRANSPORT=http`, `MCP_HTTP_HOST=127.0.0.1`, and `MCP_HTTP_PORT=3001`; `PORT` takes precedence if set in that process. The backend can use HTTP by setting `MCP_SERVER_URL=http://127.0.0.1:3001/mcp` and leaving `MCP_SERVER_COMMAND` unset. The current HTTP integration test fails during MCP initialization; use Stdio for manual frontend testing while that blocker remains unresolved.

To start the standalone MCP HTTP listener for integration work (in one PowerShell terminal):

```powershell
$env:MCP_TRANSPORT = "http"
$env:MCP_HTTP_HOST = "127.0.0.1"
$env:MCP_HTTP_PORT = "3001"
node studypilot-server/server.js
```

Start the frontend in a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Set `VITE_API_BASE_URL=http://localhost:3000` in `frontend/.env.local`; Vite exposes only `VITE_` variables to browser code. Never put Ollama credentials, provider keys, MCP command details, or other secrets in frontend variables or source files.

### API contract examples

Health check: `GET /api/health`

```json
{
  "status": "running",
  "provider": "ollama",
  "model": "llama3.2",
  "providerStatus": { "available": true },
  "mcp": { "configured": true, "connected": true, "toolCount": 5 }
}
```

Tool discovery: `GET /api/tools` returns `{ "connected": true, "toolCount": 5, "tools": [...] }`, where each tool includes its name, description, and input schema.

Plan IDs are generated internally when the user does not provide one. New plans never overwrite an existing ID. The API keeps the verified active plan associated with the frontend conversation ID, so users can refer to “my plan” without remembering its internal identifier. When a conversation has no active plan, StudyPilot lists saved plans and resolves an unambiguous choice by subject; otherwise it asks the user to choose by subject or description.

Chat: `POST /api/chat` with `Content-Type: application/json`:

```json
{ "message": "What is my progress for plan ID 2?", "messages": [] }
```

The response contains `reply`, `success`, `partialSuccess`, `rounds`, and `steps`. Invalid/missing messages return HTTP 400 with `{ "error": "A valid message is required." }`; unexpected server errors return HTTP 500 with an `error` string. Tool failures can return HTTP 200 with `success: false`, so the frontend must display the reply and failure state instead of treating every 200 response as success.

The API currently uses `cors()` with its default wildcard origin and no credentials. This is suitable for local development; restrict origins before production deployment. Keep provider calls and MCP access on the backend; do not call Ollama or MCP directly from the browser.

### Suggested components and acceptance checklist

- `ChatPanel`: message history, input, submit action, loading state (disable duplicate submits while waiting), and server reply.
- `ActivityTrace`: an optional collapsed/expandable, user-safe summary of completed tool activity; avoid displaying raw model drafts or unsupported intermediate claims.
- `HealthIndicator`: provider/MCP availability from `/api/health`.
- `ErrorNotice`: distinguish network/HTTP errors from an agent response with `success: false`.

Read the API base from `import.meta.env.VITE_API_BASE_URL` and build endpoint URLs from that value. Poll `/api/health` on startup and at a modest interval while the UI is open; show unavailable status when the request fails rather than assuming the backend is healthy. For production, replace the current wildcard CORS policy with an explicit list of trusted frontend origins.

Manual acceptance: start Ollama and the Stdio-backed API; confirm health is reachable; load discovered tools; create and retrieve a plan in a temporary/test setup; record a completed and a missed session; confirm an unknown plan displays failure; verify loading and retry behavior when the backend is stopped; confirm the UI exposes no server secrets or unsupported trace drafts.
