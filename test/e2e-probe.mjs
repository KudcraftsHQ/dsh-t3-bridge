/** Drives the bridge the way T3's Cursor driver does. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const img = readFileSync("/tmp/purple.png").toString("base64");
const cwd = process.env.HOME + "/Projects/dsh-t3-bridge";

function client() {
  const child = spawn("./bin/dsh-t3-bridge", ["--force", "acp"], { cwd, stdio: ["pipe","pipe","inherit"] });
  let buf = ""; const pending = new Map(); let id = 0; const updates = [];
  child.stdout.on("data", d => { buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0,i).trim(); buf = buf.slice(i+1); if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { console.log("[nonjson]", line); continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === "session/update") { updates.push(m.params.update);
        if (m.params.update.sessionUpdate === "agent_message_chunk") process.stdout.write(m.params.update.content.text ?? ""); }
      else if (m.id !== undefined && m.method) {
        const result = m.method === "session/request_permission"
          ? { outcome: { outcome: "selected", optionId: m.params?.options?.[0]?.optionId } } : {};
        child.stdin.write(JSON.stringify({ jsonrpc:"2.0", id:m.id, result }) + "\n"); } } });
  const call = (method, params) => new Promise(r => { const myId = ++id; pending.set(myId, r);
    child.stdin.write(JSON.stringify({ jsonrpc:"2.0", id:myId, method, params }) + "\n"); });
  return { child, call, updates };
}

const a = client();
const init = await a.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }, clientInfo: { name: "t3-code", version: "0.0.0" } });
console.log("authMethods:", JSON.stringify(init.result.authMethods));
console.log("image:", init.result.agentCapabilities.promptCapabilities.image);
console.log("authenticate:", JSON.stringify((await a.call("authenticate", { methodId: "cursor_login" })).result));
const list = await a.call("cursor/list_available_models", {});
console.log("models:", list.result.models.map(m => m.value).join(", "));
const s = await a.call("session/new", { cwd, mcpServers: [] });
const sessionId = s.result.sessionId;
console.log("sessionId:", sessionId);
const effort = s.result.configOptions?.find(o => /reason/i.test(o.name ?? "") || o.id === "effort");
console.log("effort option:", effort?.id, "=", effort?.currentValue, "->", effort?.options?.map(o=>o.value).join("/"));
console.log("set_model:", JSON.stringify((await a.call("session/set_model", { sessionId, modelId: "deepseek-flash" })).result));
console.log("set effort:", JSON.stringify((await a.call("session/set_config_option", { sessionId, configId: effort.id, value: "low" })).result?.configOptions?.find(o=>o.id===effort.id)?.currentValue));
process.stdout.write("\nvision answer: ");
const p = await a.call("session/prompt", { sessionId, prompt: [ { type: "text", text: "What single colour is this image? One word." }, { type: "image", mimeType: "image/png", data: img } ] });
console.log("\nstop:", JSON.stringify(p.result ?? p.error));
process.stdout.write("memory answer: ");
await a.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "Remember the word ORANGUTAN. Reply OK." }] });
a.child.kill();

// --- new process, resume the same session id through session/load ---
await new Promise(r => setTimeout(r, 1500));
const b = client();
await b.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} }, clientInfo: { name: "t3-code", version: "0.0.0" } });
await b.call("authenticate", { methodId: "cursor_login" });
const loaded = await b.call("session/load", { sessionId, cwd, mcpServers: [] });
console.log("\nsession/load:", loaded.result ? "ok" : JSON.stringify(loaded.error));
process.stdout.write("after restart: ");
const q = await b.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "Which word did I ask you to remember? One word." }] });
console.log("\nstop:", JSON.stringify(q.result ?? q.error));
b.child.kill();
process.exit(0);
