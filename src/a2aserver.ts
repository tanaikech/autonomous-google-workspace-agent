/**
 * A2A server
 */
import { toA2a } from "@google/adk";
import express from "express";

import { autonomousGoogleWorkspaceAgent as targetAgent } from "./agent.ts";

const port = 8000;
const host = "localhost";

async function startServer() {
  const app = express();

  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  // For A2A
  await toA2a(targetAgent, {
    protocol: "http",
    basePath: "",
    host,
    port,
    app,
  });

  app.listen(port, () => {
    console.log(`Server started on http://${host}:${port}`);
    console.log(`Try: http://${host}:${port}/.well-known/agent-card.json`);
  });
}

startServer().catch(console.error);
