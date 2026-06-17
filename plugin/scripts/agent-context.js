#!/usr/bin/env node
import { createRequire as __ctxCreateRequire } from 'module';
const __ctxRequire = __ctxCreateRequire(import.meta.url);
let __betterSqlite3, __sqliteVec, __nativeModulesAvailable;
try {
  __betterSqlite3 = __ctxRequire('better-sqlite3');
  __sqliteVec = __ctxRequire('sqlite-vec');
  __nativeModulesAvailable = true;
} catch (_nativeErr) {
  __nativeModulesAvailable = false;
}

// src/utils/env.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
function loadDotEnv() {
  const envPath = join(homedir(), ".claude-context", ".env");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[context-manager] Warning: could not read ~/.claude-context/.env:", err instanceof Error ? err.message : String(err));
    }
  }
}

// src/utils/logger.ts
import { appendFileSync, mkdirSync, statSync, readFileSync as readFileSync2, writeFileSync } from "fs";
import { join as join2 } from "path";
import { homedir as homedir2 } from "os";
var LOG_DIR = join2(homedir2(), ".claude-context", "logs");
var MAX_LOG_SIZE = 1 * 1024 * 1024;
var KEEP_SIZE = 500 * 1024;
function isDebugEnabled() {
  return process.env.CONTEXT_MANAGER_DEBUG === "1";
}
function rotateIfNeeded(logFile) {
  try {
    const stats = statSync(logFile);
    if (stats.size > MAX_LOG_SIZE) {
      const content = readFileSync2(logFile, "utf8");
      const trimmed = content.slice(content.length - KEEP_SIZE);
      const firstNewline = trimmed.indexOf("\n");
      writeFileSync(logFile, firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed);
    }
  } catch {
  }
}
function createDebugLogger(logFileName) {
  const logFile = join2(LOG_DIR, logFileName);
  return (label, data) => {
    if (!isDebugEnabled()) return;
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      rotateIfNeeded(logFile);
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      const entry = data !== void 0 ? `[${timestamp}] ${label}: ${typeof data === "string" ? data : JSON.stringify(data, null, 2)}
` : `[${timestamp}] ${label}
`;
      appendFileSync(logFile, entry);
    } catch {
    }
  };
}

// plugin/hooks/agent-context.ts
import { readFileSync as readFileSync3, existsSync } from "fs";
import { join as join3 } from "path";
import { homedir as homedir3 } from "os";
var debugLog = createDebugLogger("agent-context-hook-debug.log");
var LESSONS_CONTENT_CAP = 3e3;
var SAFE_AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
function writeResponse(data) {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(JSON.stringify(data) + "\n");
    if (ok) {
      resolve();
    } else {
      process.stdout.once("drain", resolve);
      process.stdout.once("error", reject);
    }
  });
}
function capContent(content, cap) {
  if (content.length <= cap) return content;
  const slice = content.slice(0, cap);
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
}
async function main() {
  loadDotEnv();
  try {
    const inputStr = await readStdin();
    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
    } catch {
      debugLog("PARSE_ERROR", "invalid JSON input");
      await writeResponse({});
      return;
    }
    const obj = typeof rawInput === "object" && rawInput !== null ? rawInput : {};
    const toolName = typeof obj.tool_name === "string" ? obj.tool_name : "";
    if (toolName !== "Agent") {
      await writeResponse({});
      return;
    }
    const toolInput = typeof obj.tool_input === "object" && obj.tool_input !== null ? obj.tool_input : {};
    const agentName = typeof toolInput.subagent_type === "string" ? toolInput.subagent_type.trim() : "";
    if (!agentName) {
      await writeResponse({});
      return;
    }
    if (!SAFE_AGENT_NAME.test(agentName)) {
      debugLog("AGENT_CONTEXT_INVALID_NAME", { agentName });
      await writeResponse({});
      return;
    }
    const lessonsPath = join3(homedir3(), ".claude", "agents", agentName + ".lessons.md");
    debugLog("AGENT_CONTEXT_REQUEST", { agentName, lessonsPath });
    if (!existsSync(lessonsPath)) {
      debugLog("AGENT_CONTEXT_NO_FILE", { agentName, lessonsPath });
      await writeResponse({});
      return;
    }
    const rawContent = readFileSync3(lessonsPath, "utf8");
    const content = capContent(rawContent.trim(), LESSONS_CONTENT_CAP);
    if (!content) {
      debugLog("AGENT_CONTEXT_EMPTY", { agentName });
      await writeResponse({});
      return;
    }
    debugLog("AGENT_CONTEXT_INJECT", { agentName, chars: content.length });
    await writeResponse({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: content
      }
    });
  } catch (error) {
    debugLog("AGENT_CONTEXT_ERROR", String(error));
    console.error("[context-manager] agent-context hook error:", error);
    await writeResponse({});
  }
}
main();
