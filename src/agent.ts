/**
 * @fileoverview Google Apps Script (GAS) Autonomous Development Orchestrator.
 *
 * This module defines a multi-agent system using @google/adk. It orchestrates
 * specialized sub-agents to check the environment, write, execute, debug,
 * upload/download, and summarize GAS code securely within a local sandbox
 * or directly based on the user's explicit instructions.
 */

import { LlmAgent, MCPToolset, GOOGLE_SEARCH, FunctionTool } from "@google/adk";
import { z } from "zod";
import { exec, spawnSync, ExecException } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);

/**
 * The default LLM model used across all agents in this module.
 */
const DEFAULT_MODEL = "gemini-3-flash-preview";

/**
 * JSON Schema defining the configuration for the 'gas-fakes' execution sandbox.
 * Extracted into a constant for improved readability and maintainability.
 */
const SANDBOX_PERMISSION_SCHEMA: Record<string, unknown> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Whitelist and Blacklist Configuration",
  description:
    "A configuration for whitelisting and blacklisting items and services.",
  type: "object",
  properties: {
    whitelistItems: {
      description: "A list of items to be whitelisted.",
      type: "array",
      items: {
        type: "object",
        properties: {
          itemId: {
            description:
              "The file ID and folder ID of the file on Google Drive.",
            type: "string",
          },
          read: {
            description: "Read permission for the item. Default is true.",
            type: "boolean",
          },
          write: {
            description: "Write permission for the item. Default is false.",
            type: "boolean",
          },
          trash: {
            description: "Trash permission for the item. Default is false.",
            type: "boolean",
          },
        },
        required: ["itemId"],
      },
    },
    gmailSandbox: {
      description: "Configuration for Gmail sandbox settings.",
      type: "object",
      properties: {
        emailWhitelist: {
          description: "List of email addresses allowed to receive emails.",
          type: "array",
          items: { type: "string" },
        },
        usageLimit: {
          description: "Limits for operations. Can be a number or an object.",
          type: ["number", "object"],
        },
        labelWhitelist: {
          description: "Configuration for allowed labels and permissions.",
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { description: "Label name", type: "string" },
              read: { description: "read", type: "boolean" },
              write: { description: "write", type: "boolean" },
              delete: { description: "delete", type: "boolean" },
              send: { description: "send", type: "boolean" },
            },
          },
        },
        cleanup: {
          description:
            "Controls whether artifacts created in the session are trashed on cleanup.",
          type: "boolean",
        },
      },
    },
    calendarSandbox: {
      description: "Configuration for Calendar sandbox settings.",
      type: "object",
      properties: {
        calendarWhitelist: {
          description: "Configuration for allowed calendars and permissions.",
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { description: "Calendar name", type: "string" },
              read: { description: "read", type: "boolean" },
              write: { description: "write", type: "boolean" },
              delete: { description: "delete", type: "boolean" },
            },
            required: ["name"],
          },
        },
        usageLimit: {
          description: "Limits for operations.",
          type: ["number", "object"],
        },
        cleanup: {
          description:
            "Controls whether calendars created are deleted on cleanup.",
          type: "boolean",
        },
      },
    },
    whitelistServices: {
      description: "A list of services to be whitelisted.",
      type: "array",
      items: {
        type: "object",
        properties: {
          className: {
            description: "The name of the class of the service.",
            type: "string",
          },
          methodNames: {
            description:
              "A list of method names for the class to be whitelisted.",
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["className"],
      },
    },
    blacklistServices: {
      description: "A list of services to be blacklisted.",
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["whitelistItems"],
};

// ==========================================
// Agent Instructions (Prompts)
// ==========================================

const AGENT_INSTRUCTIONS = {
  ENVIRONMENT_CHECKER: `You are 'environment_checker'. Your objective is to verify if '@google/clasp' and '@mcpher/gas-fakes' are installed globally.
Use the 'check_cli_installation' tool to perform this check.
Report clearly to the orchestrator whether both, one, or none of them are installed.`,

  SCRIPT_WRITER: `You are 'script_writer', an expert Google Apps Script (GAS) developer.
Your primary objective is to write, debug, and refine Google Apps Script code to ensure it executes successfully within a local testing environment using the 'gas-fakes' library.

### Tool Usage Guidelines
1. Workspace Developer MCP:
   - Use this tool to reference the latest API specifications and documentation directly from Google Workspace. Ensure you are using the correct services, methods, and object structures.

2. Google Search (GOOGLE_SEARCH):
   - Search Priority: When looking for sample scripts or implementations, prioritize searching on Stack Overflow first (e.g., by appending "site:stackoverflow.com" to your query).
   - Broad Search: If sufficient information isn't found, perform broader searches (official tutorials, blogs, forums).
   - Troubleshooting: If the script fails, use Google Search to investigate specific error messages or understand specific behaviors of the 'gas-fakes' environment.

### Code Generation & Output Rules
1. Executable Code Block: Your output MUST strictly include the complete, runnable TypeScript or JavaScript code enclosed in a standard markdown code block.
2. 'gas-fakes' Context: Write your code assuming it is executed in the 'gas-fakes' environment. Keep in mind that certain advanced features might have mocked limitations.
3. Entry Point Invocation: Since the code will be executed as a direct string, you MUST ensure that the main entry function is explicitly called at the very bottom of your script (e.g., \`function main() { /* logic */ } main();\`).

### Error Handling & Iteration
- When reported a failure from the previous step, carefully analyze the provided stderr/stdout execution logs.
- Identify the exact root cause (syntax error, API payload issue, missing permissions, etc.).
- Always provide the fully corrected and executable code block in your response.`,

  SCRIPT_EXECUTOR: (
    schemaStr: string,
  ) => `You are 'script_executor', an expert testing agent responsible for verifying Google Apps Script (GAS) code.
Your objective is to execute the provided script locally using the 'run_gas_in_sandbox' tool and report the exact results to the 'script_writer'.

### Tool Usage Guidelines ('run_gas_in_sandbox')
1. Script Execution Target:
   - Provide the direct GAS code string in the 'script' argument.
   - IMPORTANT: Ensure the entry function is called at the end of the string.

2. Sandbox Configurations ('useSandbox' and 'json'):
   - Read the user's prompt carefully. If the prompt explicitly states NOT to use the sandbox, set 'useSandbox' to false. Otherwise, you MUST set 'useSandbox' to true (default behavior).
   - If 'useSandbox' is true, you MUST pass a JSON configuration string via the 'json' argument to define the sandbox permissions.
   - Construct the 'json' argument strictly according to this JSON schema:
${schemaStr}
   - Include all necessary method names in 'whitelistServices' to avoid permission errors.
   - If 'useSandbox' is false, the 'json' argument is not required and can be left empty.

### Evaluation & Output Rules
1. Execution Succeeded: If the tool returns successfully, return 'SUCCESS' along with the complete stdout execution logs.
2. Execution Failed: If the tool indicates an error, return 'FAILED' along with the exact stderr/stdout output.
3. Security Notice: You MUST explicitly state in your output whether the Google Apps Script was executed "WITH the sandbox" or "WITHOUT the sandbox".`,

  SCRIPT_UPLOADER: `You are 'script_uploader', an expert at managing Google Apps Script projects on Google Drive using the 'clasp' CLI via MCP.
Your primary objective is to upload (push), download (pull), or create (create) GAS projects directly on Google Drive.

### Usage Guidelines & Strict File Operation Rules:
- The orchestrator will invoke you only if '@google/clasp' is confirmed to be installed.
- **Uploading a Script (MANDATORY WORKFLOW)**:
  When uploading a file using clasp, you MUST follow these precise steps:
  1. Create the project via clasp (if a new directory is needed).
  2. **Save the Script**: Use the 'save_script_file' tool to save the generated script as a file (e.g., .js or .gs) inside the directory created by clasp.
  3. **Execute Push**: Only AFTER the file has been successfully saved, execute the clasp push command to upload it.
- Ensure to handle authentication or missing project contexts appropriately.
- Report the detailed outcome of your file creation and clasp operations.`,

  SUMMARY: `Summarize the final deliverables in the following format:
1. Execution Summary (Whether it succeeded, was skipped, and what processes were executed).
2. Final Script Code (Clean code block, ready to be copied and used).
3. Execution Results / Data. You MUST explicitly mention whether the script was executed WITH a sandbox or WITHOUT a sandbox.
4. System Guidance (Include any specific guidance required from the orchestrator regarding missing CLIs or Drive sync capabilities).`,

  ORCHESTRATOR: `You are a Senior Multi-Agent Orchestrator and the leader coordinating multiple sub-agents. Your primary role is to deeply understand the given prompt, select the optimal sub-agents, and execute them in the optimal order to autonomously develop, test, and manage Google Apps Script (GAS) solutions, ensuring the prompt's tasks are accomplished reliably.

### Handling Missing Information (Crucial Requirement)
If any information required to achieve the task in the prompt is missing (e.g., specific requirements, Google Drive Folder IDs, target service names), you MUST provide feedback to the user requesting the necessary details. Once the user provides the missing information, you must resume the workflow and aim to achieve the prompt's task based on the added context.

### Available Sub-Agents & Expertise:
- "environment_checker" (agent0): Checks if '@google/clasp' and '@mcpher/gas-fakes' are installed.
- "script_writer" (agent1): References Google Workspace API docs and writes gas-fakes compatible code.
- "script_executor" (agent2): Simulates script execution in the gas-fakes environment (with or without a sandbox).
- "script_uploader" (agent3): Manages GAS projects via clasp and handles file saves prior to upload.
- "summary_agent" (agent4): Formats the final deliverables into a structured report.

### Operational Protocols:
1. **Selection & Purpose**: Clearly identify which agent(s) you are using and why. You must determine the optimal sequence of execution based on the task's complexity.
2. **Execution Strategy**:
   - **Environment Check (Mandatory First Step)**:
     - BEFORE invoking 'script_executor' or 'script_uploader', you MUST use 'environment_checker' to verify installations.
     - **If '@mcpher/gas-fakes' is NOT installed**: Skip execution, return ONLY the generated script, and instruct the user to install it via \`npm -g install @mcpher/gas-fakes\`.
     - **If '@google/clasp' IS installed**: Explicitly state that the user can upload, download, or create scripts directly on Google Drive.
     - **Clasp Independence**: Inform the user that creating and executing GAS locally is still possible as long as 'gas-fakes' is installed.

   - **Direct Execution (If provided by the user)**:
     - If the user provides Google Apps Script code directly in their prompt and asks to execute it, you can bypass the 'script_writer' and pass the provided script directly to the 'script_executor'.

   - **Iterative Workflow (If gas-fakes is installed)**:
     1. Ask 'script_writer' to generate code.
     2. Pass the code to 'script_executor' for simulation.
     3. If 'FAILED', pass the details back to 'script_writer' for regeneration.
     4. **Constraint**: The cycle has a MAXIMUM limit of 5 retries.
     
   - **Script Management (Optional, if clasp is installed)**:
     - Use 'script_uploader' if project creation/upload is requested. Ensure you communicate that files will be generated before pushing.

   - **Serial (Finalization)**:
     Once execution succeeds or limits are reached, invoke 'summary_agent' to generate the final guaranteed output.

3. **Reporting (Strict Requirement)**: You MUST start your response with an "Execution Log".

### Mandatory Output Format (in English):
---
## Execution Log
- **Agents Involved**:[List names of agents used]
- **Execution Strategy**: [Iterative / Serial / Direct Execution / Awaiting User Input]
- **Purpose & Logic**:[Briefly explain the coordination, environment check results, retry cycles, or reason for requesting missing information]

## Result[Provide the comprehensive final answer in the requested language, incorporating the output from summary_agent, and the necessary feedback about missing CLIs, Drive capabilities, or missing information required from the user]`,
};

// ==========================================
// Tool Definitions
// ==========================================

/**
 * Tool for verifying the installation of necessary global npm CLI tools.
 */
const checkCliInstallationTool = new FunctionTool({
  name: "check_cli_installation",
  description:
    "Check if @google/clasp and @mcpher/gas-fakes are installed globally via npm.",
  parameters: z.object({}),
  execute: async () => {
    let stdout = "";
    try {
      const result = await execAsync("npm -g ls --depth=0");
      stdout = result.stdout;
    } catch (error: unknown) {
      // npm ls returns a non-zero exit code if some dependencies have issues,
      // but stdout might still contain the requested tree.
      const execError = error as ExecException & { stdout?: string };
      stdout = execError.stdout || "";
    }

    const hasClasp = stdout.includes("@google/clasp");
    const hasGasFakes = stdout.includes("@mcpher/gas-fakes");

    return [
      `Global npm packages check result:`,
      `- @google/clasp: ${hasClasp ? "Installed" : "Not Installed"}`,
      `- @mcpher/gas-fakes: ${hasGasFakes ? "Installed" : "Not Installed"}`,
    ].join("\n");
  },
});

/**
 * Tool for saving the GAS code to a local file before uploading with clasp.
 */
const saveScriptFileTool = new FunctionTool({
  name: "save_script_file",
  description:
    "Save the generated Google Apps Script code to a local file in a specified directory.",
  parameters: z.object({
    directory: z
      .string()
      .describe(
        "The directory path where the file should be saved (must be the directory created by clasp).",
      ),
    filename: z
      .string()
      .describe("The name of the file (e.g., 'main.js' or 'Code.gs')."),
    content: z
      .string()
      .describe("The generated Google Apps Script code content to save."),
  }),
  execute: async ({ directory, filename, content }) => {
    try {
      await fs.mkdir(directory, { recursive: true });
      const filePath = path.join(directory, filename);
      await fs.writeFile(filePath, content, "utf-8");

      return `SUCCESS: The script has been successfully saved to ${filePath}. You can now proceed to execute the clasp push command from this directory.`;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `FAILED: Could not save the script. Error details: ${errorMessage}`;
    }
  },
});

/**
 * Custom Tool: gas-fakes CLI Executor
 * Executes a given Google Apps Script string locally, optionally in a sandbox.
 */
const runGasInSandboxTool = new FunctionTool({
  name: "run_gas_in_sandbox",
  description:
    "Executes a provided Google Apps Script code string locally using the gas-fakes CLI. It supports running with or without a sandbox.",
  parameters: z.object({
    script: z
      .string()
      .describe(
        "The executable Google Apps Script code. It MUST ensure the entry function is explicitly called at the end of the string.",
      ),
    useSandbox: z
      .boolean()
      .describe(
        "Set to true to use the sandbox (-x). Set to false only if the prompt explicitly mentions not to use a sandbox.",
      ),
    json: z
      .string()
      .optional()
      .describe(
        "A JSON string containing the sandbox configuration based on the SANDBOX_PERMISSION_SCHEMA. Required if useSandbox is true.",
      ),
  }),
  execute: async ({ script, useSandbox, json }) => {
    try {
      if (useSandbox && !json) {
        return "FAILED: 'json' argument is required when 'useSandbox' is true.";
      }

      const args = useSandbox
        ? ["-x", "-s", script, "-j", json!]
        : ["-s", script];

      // 1. Attempt to execute the script directly from the command line using the -s option.
      let result = spawnSync("gas-fakes", args, {
        encoding: "utf-8",
      });

      // 2. If direct execution fails, fallback to executing via a temporary file using the -f option.
      if (result.error || result.status !== 0) {
        const tempFilePath = path.join(
          os.tmpdir(),
          `gas_temp_${Date.now()}.js`,
        );

        await fs.writeFile(tempFilePath, script, "utf-8");

        const fallbackArgs = useSandbox
          ? ["-x", "-f", tempFilePath, "-j", json!]
          : ["-f", tempFilePath];

        result = spawnSync("gas-fakes", fallbackArgs, {
          encoding: "utf-8",
        });

        // Clean up the temporary file, ignore errors if cleanup fails
        await fs.unlink(tempFilePath).catch(() => {
          /* Silent ignore */
        });
      }

      if (result.error) {
        return `Failed to execute CLI command: ${result.error.message}`;
      }

      if (result.status !== 0) {
        return `Execution Failed (Status ${result.status}).\n--- STDERR ---\n${result.stderr}\n--- STDOUT ---\n${result.stdout}`;
      }

      const sandboxStatus = useSandbox ? "WITH sandbox" : "WITHOUT sandbox";
      return `Execution Succeeded (${sandboxStatus}).\n--- STDOUT ---\n${result.stdout}`;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return `Unexpected error during execution: ${errorMessage}`;
    }
  },
});

// ==========================================
// Sub-Agents Definition
// ==========================================

/**
 * Agent 0: Environment Checker Agent
 */
const environmentCheckerAgent = new LlmAgent({
  name: "environment_checker",
  model: DEFAULT_MODEL,
  description:
    "Checks if the required CLI tools (@google/clasp and @mcpher/gas-fakes) are installed globally.",
  instruction: AGENT_INSTRUCTIONS.ENVIRONMENT_CHECKER,
  tools: [checkCliInstallationTool],
});

/**
 * Agent 1: Script Writer Agent (MCP Integrated)
 */
const scriptWriterAgent = new LlmAgent({
  name: "script_writer",
  model: DEFAULT_MODEL,
  description:
    "References Google Workspace API specifications via MCP and generates code for the gas-fakes environment. Analyzes and fixes errors.",
  instruction: AGENT_INSTRUCTIONS.SCRIPT_WRITER,
  tools: [
    new MCPToolset({
      type: "StreamableHTTPConnectionParams",
      url: "https://workspace-developer.goog/mcp",
    }),
    GOOGLE_SEARCH,
  ],
  generateContentConfig: {
    toolConfig: {
      includeServerSideToolInvocations: true,
    },
  },
});

/**
 * Agent 2: Script Execution and Verification Agent
 */
const scriptExecutorAgent = new LlmAgent({
  name: "script_executor",
  model: DEFAULT_MODEL,
  description:
    "Simulates script execution using the gas-fakes environment (with or without a sandbox) and handles error reporting.",
  instruction: AGENT_INSTRUCTIONS.SCRIPT_EXECUTOR(
    JSON.stringify(SANDBOX_PERMISSION_SCHEMA),
  ),
  tools: [runGasInSandboxTool],
});

/**
 * Agent 3: Script Uploader Agent
 */
const scriptUploaderAgent = new LlmAgent({
  name: "script_uploader",
  model: DEFAULT_MODEL,
  description:
    "Uploads, downloads, or creates Google Apps Script projects on Google Drive using clasp. Used only when @google/clasp is installed.",
  instruction: AGENT_INSTRUCTIONS.SCRIPT_UPLOADER,
  tools: [
    new MCPToolset({
      type: "StdioConnectionParams",
      serverParams: {
        command: "clasp",
        args: ["mcp"],
      },
    }),
    saveScriptFileTool,
  ],
});

/**
 * Agent 4: Summary Agent
 */
const summaryAgent = new LlmAgent({
  name: "summary_agent",
  model: DEFAULT_MODEL,
  description: "Formats the final deliverables into a structured report.",
  instruction: AGENT_INSTRUCTIONS.SUMMARY,
});

// ==========================================
// Orchestrator Agent Definition
// ==========================================

/**
 * Main Coordinator Agent (Autonomous Execution & Retry Control)
 */
export const autonomousGoogleWorkspaceAgent = new LlmAgent({
  name: "autonomous-google-workspace-agent",
  model: DEFAULT_MODEL,
  description:
    "Senior Orchestrator managing GAS creation, environment check, execution, clasp integration, and up to 5 retries.",
  instruction: AGENT_INSTRUCTIONS.ORCHESTRATOR,
  subAgents: [
    environmentCheckerAgent,
    scriptWriterAgent,
    scriptExecutorAgent,
    scriptUploaderAgent,
    summaryAgent,
  ],
});
