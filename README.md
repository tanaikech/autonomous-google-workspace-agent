<a name="top"></a>

# Autonomous AI Agent for Dynamic Tool Creation and Google Workspace Automation

This repository provides a robust framework for an **Autonomous AI Agent** capable of dynamically creating, testing, and executing original tools to process complex tasks. By leveraging **Google Apps Script (GAS)**, **gas-fakes**, and **@google/adk**, this system overcomes "Tool Space Interference" by generating the exact code it needs on the fly.

## Overview

This project implements a multi-agent orchestration system where specialized sub-agents collaborate to handle the entire lifecycle of a tool:

1.  **Environment Checker (agent0):** Verifies the installation of required CLI tools ([`clasp`](https://github.com/google/CLASP) and [`gas-fakes`](https://github.com/brucemcpherson/gas-fakes)) in the host environment.
2.  **Script Writer (agent1):** An expert GAS developer that references official Workspace documentation via **MCP** and writes code compatible with the `gas-fakes` environment.
3.  **Script Executor (agent2):** Securely executes the generated script in a local **sandboxed environment** to validate the logic before any real-world application.
4.  **Script Uploader (agent3):** Manages Google Drive synchronization using the `clasp` CLI to push validated projects to the cloud.
5.  **Summary Agent (agent4):** Synthesizes execution logs, source code, and final data into a clean, structured report.
6.  **Senior Orchestrator:** The master agent that manages the iterative workflow, handling up to 5 retries for autonomous error correction.

For a detailed technical walkthrough, please refer to the article: **[The Agentic Enterprise in Action: Empowering Autonomous AI Agents through Dynamic Tool Creation](https://medium.com/google-cloud/empowering-autonomous-ai-agents-through-dynamic-tool-creation-550683f255a4)**

---

## Features

- **Dynamic Tool Generation:** Generates original Google Apps Script code in real-time to solve edge-case tasks.
- **Local Sandboxing:** Uses `gas-fakes` to simulate Google Workspace APIs locally, ensuring high-speed and secure execution without cloud latency.
- **Multi-Agent Orchestration:** Coordinates specialized agents for writing, debugging, executing, and uploading code.
- **Autonomous Error Correction:** Automatically analyzes execution errors (stderr/stdout) and regenerates code until the task succeeds.
- **A2A & Gemini CLI Ready:** Fully compatible with the Agent-to-Agent protocol and can be integrated as a remote sub-agent in the Gemini CLI.

---

## Setup Instructions

### 1. Prerequisites

- Node.js (v18 or later)
- Gemini API Key (Set as `GEMINI_API_KEY` in your environment)
- Global CLI Tools:

  ```bash
  npm install -g @mcpher/gas-fakes @google/clasp
  ```

### 2. Installation

```bash
git clone https://github.com/tanaikech/autonomous-google-workspace-agent
cd autonomous-google-workspace-agent
npm install
```

### 3. Running the Agent as Web server

Launch the interactive web interface to test the agent locally.

```bash
npm run web
```

The actual result is as follows:

```bash
$ npm run web

> adk-full-samples@1.0.0 web
> npx adk web src/agent.ts

+-----------------------------------------------------------------------------+
| ADK API Server started                                                      |
|                                                                             |
| For local testing, access at http://localhost:8000.                         |
+-----------------------------------------------------------------------------+
```

### 4. Running the Agent as A2A server

Launch the A2A server to use this agent as a sub-agent for Gemini CLI.

```bash
npm run a2a
```

To integrate with Gemini CLI, create `.gemini/agents/autonomous-google-workspace-agent.md`:

```text
---
kind: remote
name: autonomous-google-workspace-agent
agent_card_url: http://localhost:8000/.well-known/agent-card.json
---
```

---

## Usage Examples

### 1. Dynamic Financial Data Retrieval

**Prompt:** _"Create a new Google Spreadsheet, put the formula `=GOOGLEFINANCE("CURRENCY:USDJPY")` in cell A1, and retrieve the value."_

- **Logic:** The agent generates GAS code to create a sheet, sets the formula, waits for calculation (if necessary), and returns the result using `gas-fakes`.

### 2. Autonomous Calendar Scheduling

**Prompt:** _"Schedule a 'Monthly Team Meeting' for 1 hour at 10:00 AM on the second Monday of next month in my calendar."_

- **Logic:** The orchestrator calculates the specific date, handles API validation via the `script_writer`, and executes the event creation.

### 3. Error-Correcting Document Automation

**Prompt:** _"Find the keyword 'TODO' in my Google Doc and highlight it in yellow. If you encounter errors, fix them and retry."_

- **Logic:** If the initial code fails (e.g., wrong method name), the agent analyzes the stack trace, fixes the code, and re-executes.

### 4. Integrated Drive Reporting

**Prompt:** _"List all files in folder ID '{FOLDER_ID}' modified in the last week and create a Gmail draft report to 'example@email.com'."_

- **Logic:** Combines Drive API and Gmail API interactions in a single dynamically generated tool.

### 5. Local to Cloud Deployment

**Prompt:** _"Create a GAS function to clean up old files, test it locally, and if successful, push it to a new project on Drive named 'Cleanup Tool'."_

- **Logic:** Uses `script_executor` for local validation and `script_uploader` via `clasp` for final deployment.

---

<a name="license"></a>

## License

[MIT](https://tanaikech.github.io/license/)

<a name="author"></a>

## Author

[Tanaike](https://tanaikech.github.io/about/)

---

## Update History

- v1.0.0 (April 24, 2026)
  - Initial release with Multi-agent Dynamic Tool Creation framework.

[TOP](#top)
