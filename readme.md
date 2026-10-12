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

The StudyPilot MCP server exposes 4 tools via the official `@modelcontextprotocol/sdk`:

1. **`create_study_plan`**
   - **Description**: Generates an initial priority-weighted study schedule from a subject list, exam date, daily available hours, and optional subject priorities (`high`, `medium`, `low`).
   - **Parameters**: `subjects` (array/string), `examDate` (YYYY-MM-DD), `dailyAvailableHours` (number), `priorities` (object, optional), `planId` (string, optional).

2. **`get_study_plan`**
   - **Description**: Retrieves the saved study plan, showing total completed hours, missed hours, remaining workload, progress percentage, and recent session logs.
   - **Parameters**: `planId` (string, optional, defaults to `"default"`).

3. **`record_study_session`**
   - **Description**: Records a completed, partially completed, or missed session. Updates subject progress and logs missed hours if a session was skipped.
   - **Parameters**: `subject` (string), `hoursSpent` (number), `status` (`completed` | `partially_completed` | `missed`), `notes` (string, optional), `date` (YYYY-MM-DD, optional), `planId` (string, optional).

4. **`adapt_study_plan`**
   - **Description**: Re-evaluates remaining days until the exam, recalculates subject hour allocations, prioritizes backlog recovery from missed sessions, and warns if the remaining workload requires increasing daily study hours.
   - **Parameters**: `planId` (string, optional), `reason` (string, optional), `newExamDate` (YYYY-MM-DD, optional), `newDailyAvailableHours` (number, optional).

---

## Getting Started

### Prerequisites

1. **Node.js**: v18+ (tested on Node.js v22)
2. **Ollama**: Running locally with `llama3.2` installed:
   ```bash
   ollama pull llama3.2
   ```

### Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Default configuration in `.env`:

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
2. Discovers and asserts all 4 StudyPilot tools.
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
