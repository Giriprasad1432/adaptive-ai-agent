# Adaptive AI Agent & StudyPilot

An autonomous, general-purpose reasoning agent and adaptive learning productivity platform built with Node.js (ES Modules), Express, the official Model Context Protocol (MCP), and production-grade LLM inference via **Groq API** (with Ollama and built-in fallback support).

---

## 🌟 Key Features

1. **Production Groq API Engine**:
   - Ultra-low latency inference using `llama-3.3-70b-versatile`.
   - Production hardening: exponential backoff retry on HTTP 429/503 rate limits, configurable timeouts (`GROQ_TIMEOUT_MS`), parallel tool call execution, and zero API key exposure in error logs.
   - Resilient fallback: seamlessly falls back to the built-in offline study assistant if credentials are unconfigured.

2. **Dual-Persona Reasoning Architecture**:
   - **Academic Tutoring & Conceptual Q&A**: Explains complex topics across Computer Science, Mathematics, Physics, Chemistry, and Engineering (e.g., Recursion, BFS vs. DFS, Deadlocks, Normalization, Calculus) with structured Markdown, code blocks, and pedagogical reasoning—without inappropriately calling plan-management tools.
   - **StudyPilot Adaptive Planning**: Creates balanced study schedules, records completed or missed sessions, calculates remaining workloads, and rebalances schedules dynamically.
   - **Multi-Turn Requirement Aggregation**: Preserves conversational context across multiple turns (e.g., subjects in Turn 1, duration in Turn 2, daily capacity in Turn 3).

3. **13 Full-Featured MCP Tools**:
   - `list_study_plans`: Discover all saved plans.
   - `create_study_plan`: Create priority-weighted exam or goal-based schedules.
   - `get_study_plan`: Retrieve verified plan metrics and recent session records.
   - `delete_study_plan`: Delete one selected plan and its session history after explicit confirmation.
   - `record_study_session`: Log completed or missed study hours.
   - `adapt_study_plan`: Dynamically recalculate allocations after missed sessions.
   - `create_quiz`: Generate multi-choice practice quizzes with explanations.
   - `save_quiz_result`: Save quiz scores and evaluate subject mastery.
   - `get_weak_topics`: Identify weak areas from missed sessions and low quiz scores (<70%).
   - `get_study_progress`: Aggregate global metrics across all active plans.
   - `get_user_preferences`: Retrieve user learning style and study preferences.
   - `update_user_preferences`: Save or modify explanation style, preferred language, and pace.
   - `reset_learning_data`: Clear all locally stored plans, sessions, preferences, and quiz data after explicit confirmation. Study plans are currently global, so this reset affects all stored users.

4. **Alexa+ & Remote Streamable HTTP MCP Integration**:
   - Dual transport support: runs over **STDIO** for local agent orchestration or **Streamable HTTP** (`/mcp` endpoint) with optional Bearer token authorization (`MCP_AUTH_TOKEN`).
   - Fully compliant with the official Model Context Protocol JSON-RPC 2.0 specification for remote assistants like Alexa+, Claude Desktop, and enterprise multi-agent networks.

5. **Modern Glassmorphic Web App**:
   - Vite + React frontend with dark-mode aesthetic.
   - Interactive Markdown renderer with syntax-highlighted code blocks and copy buttons.
   - Live backend health status and active MCP tool indicators.

---

## 🏗️ Architecture Overview

```text
adaptive-ai-agent/
├── src/
│   ├── server.js                   # Express application entrypoint (/api/health, /api/tools, /api/chat)
│   ├── agent/                      # Core agent reasoning & execution loop
│   │   ├── adaptiveAgent.js        # Bounded multi-round loop with tool invocation & error handling
│   │   ├── normalizer.js           # Argument normalization, date parsing, & intent classification
│   │   ├── validator.js            # Input schema validation & tool execution verification
│   │   ├── consistencyChecker.js   # Grounded response verifier ensuring zero hallucinated metrics
│   │   ├── prompts.js              # Dual-persona system prompt & operational rules
│   │   └── index.js                # Agent factory & exports
│   ├── providers/                  # Provider abstraction layer
│   │   ├── baseProvider.js         # Abstract provider contract
│   │   ├── groqProvider.js         # Hardened Groq SDK client (429 retries, timeouts, sanitization)
│   │   ├── ollamaProvider.js       # Local Ollama adapter
│   │   ├── demoProvider.js         # Built-in offline resilient assistant
│   │   └── index.js                # Provider registry & resilient wrappers
│   └── mcp/                        # MCP Client integration layer
│       ├── mcpClient.js            # Stdio & Streamable HTTP client manager
│       └── index.js                # Singleton client accessor
├── studypilot-server/              # StudyPilot MCP Server
│   ├── server.js                   # MCP server registering 13 StudyPilot tools (Stdio & HTTP)
│   ├── planner.js                  # Study planning, capacity math, & schedule adaptation algorithms
│   ├── quizManager.js              # Quiz generation, mastery evaluation, & weak topic detection
│   ├── storage.js                  # Atomic file-locked persistent JSON storage
│   └── data/                       # JSON persistent storage
├── frontend/                       # Vite + React UI demo
│   ├── src/
│   │   ├── App.jsx                 # Markdown-enabled chat interface with activity traces
│   │   └── App.css                 # Dark-mode theme, glassmorphism, & code block styling
│   └── vite.config.js              # Proxies /api requests to port 3000
└── test/                           # 14 deterministic test suites
```

---

## 🛠️ StudyPilot MCP Tools Reference

| Tool Name | Purpose | Key Parameters |
| :--- | :--- | :--- |
| **`list_study_plans`** | Enumerate saved study plans with subject summaries and progress. | None |
| **`create_study_plan`** | Generate an initial priority-weighted study schedule. | `subjects`, `examDate` (optional), `durationDays` (optional), `dailyAvailableHours` (optional), `priorities` (optional), `planId` (optional) |
| **`get_study_plan`** | Retrieve verified plan data, completed hours, remaining workload, and recent sessions. | `planId` (optional; resolved safely from context) |
| **`delete_study_plan`** | Delete one selected plan and its recorded sessions; quiz history is preserved. | `planId`, `confirm: true` (required) |
| **`record_study_session`** | Log completed or missed study hours. | `subject`, `hoursSpent`, `status` (`completed` \| `partially_completed` \| `missed`), `missedHours`, `scheduledHours`, `date`, `dayNumber`, `planId` |
| **`adapt_study_plan`** | Dynamically adjust remaining workload after missed sessions. | `planId`, `reason`, `newExamDate` (optional), `newDailyAvailableHours` (optional) |
| **`create_quiz`** | Generate an interactive practice quiz with questions, options, and explanations. | `subject`, `topic` (optional), `questionCount` (optional, 1-10), `difficulty` (optional) |
| **`save_quiz_result`** | Record quiz score and evaluate concept mastery. | `subject`, `score`, `totalQuestions`, `topic` (optional), `quizId` (optional) |
| **`get_weak_topics`** | Identify topics needing remediation based on low quiz scores (<70%) or missed hours. | `planId` (optional), `subject` (optional) |
| **`get_study_progress`** | Aggregate workload and quiz completion metrics across all active plans. | `planId` (optional; returns global stats if omitted) |
| **`get_user_preferences`** | Retrieve stored learning and study preferences. | `userId` (optional) |
| **`update_user_preferences`** | Save or update explanation style, preferred language, daily availability, and notes. | `preferredExplanationStyle` (optional), `preferredLanguage` (optional), `defaultDailyAvailableHours` (optional), `targetDifficulty` (optional), `customNotes` (optional), `userId` (optional) |
| **`reset_learning_data`** | Clear all local plans, sessions, preferences, and quiz data after explicit confirmation. This is global because plans are not user-scoped. | `confirm: true` (required) |

---

## 🚀 Quick Start Guide

### 1. Prerequisites
- **Node.js**: v18+ (tested on v22.17.0)
- **Groq API Key**: (Get one at [console.groq.com](https://console.groq.com)) or use the built-in offline assistant.

### 2. Configuration
Copy the configuration template:
```bash
cp .env.example .env
```

Configure your `.env`:
```env
PORT=3000
AI_PROVIDER=groq
GROQ_API_KEY=gsk_your_groq_api_key_here
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_TIMEOUT_MS=20000

# StudyPilot MCP Server (Stdio)
MCP_SERVER_COMMAND=node
MCP_SERVER_ARGS=./studypilot-server/server.js
```

### 3. Run Backend & Frontend
In Terminal 1 (Backend API & MCP Server):
```bash
npm start
```
*Backend runs on `http://localhost:3000`.*

In Terminal 2 (Frontend Demo):
```bash
cd frontend
npm run dev
```
*Frontend opens at `http://localhost:5173`.*

---

## 🧪 Comprehensive Test Suite

The `npm test` command runs these 14 test files:

```bash
npm test
```

### Test Suites Included:
1. `test/groq_provider.test.js`: Rate-limit backoff, timeouts, key sanitization, parallel tool calls.
2. `test/demo_provider.test.js`: Offline provider greetings and missed-session amount mapping.
3. `test/academic_tutoring.test.js`: General-purpose multi-subject Q&A, debugging assistance & multi-turn aggregation.
4. `test/user_preferences.test.js`: User personalization, preference persistence, and user isolation.
5. `test/reset_learning_data.test.js`: Confirmed single-plan deletion and global reset using isolated temporary data.
6. `test/expanded_mcp_tools.test.js`: Quiz creation, mastery scoring, weak topic detection, progress aggregation.
7. `test/argument_normalization.test.js`: Comprehensive schema normalizer and intent verification.
8. `test/studypilot_mcp.test.js`: Stdio MCP protocol contract and plan accounting.
9. `test/failure_handling.test.js`: Symmetric partial success handling and tool timeouts.
10. `test/phase3_regressions.test.js`: Regression suite covering plan IDs, date recovery, and capacity bounds.
11. `test/study_plan_dates_recovery.test.js`: Inclusive date bounds, Day N mapping, and malformed JSON recovery.
12. `test/api_contract.test.js`: Express HTTP API contracts (`/api/health`, `/api/tools`, `/api/chat`).
13. `test/agent_evaluation.test.js`: End-to-end autonomous agent multi-step evaluation.
14. `test/studypilot_http.test.js`: Streamable HTTP MCP server verification (`/mcp` endpoint) & Bearer token auth.


---

## 📡 Remote Streamable HTTP MCP (Alexa+ Integration)

StudyPilot supports running as a remote Streamable HTTP MCP server for Alexa+, remote cloud agents, or enterprise MCP hosts.

### Launching in Streamable HTTP Mode:
```bash
MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_PORT=8000 node studypilot-server/server.js
```
The server will listen at `http://<host>:8000/mcp`.

### Client Configuration (e.g. `mcpClient.js` or Alexa+ MCP Configuration):
```json
{
  "mcpServers": {
    "studypilot": {
      "url": "http://127.0.0.1:8000/mcp",
      "transport": "streamable-http"
    }
  }
}
```
Any remote client can now invoke all 9 tools via standard JSON-RPC 2.0 with complete session isolation and security.
