import { spawn } from "node:child_process";

const webArguments = ["run", "dev:web"];
if (process.env.JARVIS_WEB_PORT) webArguments.push("--", "--host", "127.0.0.1", "--port", process.env.JARVIS_WEB_PORT);

const processes = [
  spawn("npm", webArguments, { stdio: "inherit" }),
  spawn("npm", ["run", "dev:indexer"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev:speech"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev:voice"], { stdio: "inherit" }),
];
let shuttingDown = false;

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) {
    if (!child.killed) child.kill(signal);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));

processes[0].on("exit", (code) => {
  shutdown();
  process.exitCode = code ?? 0;
});

processes[1].on("exit", (code) => {
  if (!shuttingDown && code !== 0) {
    console.warn("The local knowledge indexer stopped; the interface keeps the last index view.");
  }
});

processes[2].on("exit", (code) => {
  if (!shuttingDown && code !== 0) {
    console.warn("Local speech-to-text is unavailable; the web interface remains active.");
  }
});

processes[3].on("exit", (code) => {
  if (!shuttingDown && code !== 0) {
    console.warn("The local voice service is unavailable; JARVIS falls back to the macOS voices.");
  }
});
