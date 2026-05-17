import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../../");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");
const REGISTER_HOOK = path.resolve(__dirname, "../run.ts");

/**
 * Spawn a child node that:
 *   1. Writes a "running" RunMeta to a temp data dir.
 *   2. Calls `registerActiveRun(...)` so the shutdown handler is installed.
 *   3. Prints "READY" and idles via setInterval.
 *
 * The test then sends the requested signal and waits for exit, with a
 * hard timeout so a regression (handler suppresses default termination
 * without providing an exit path → hang) shows up as a clear failure
 * instead of a hung suite.
 */
function spawnShutdownChild(opts: {
  dataRoot: string;
  projectId: string;
  runId: string;
}): Promise<{ child: ReturnType<typeof spawn>; ready: Promise<void> }> {
  const script = `
    import { registerActiveRun } from ${JSON.stringify(REGISTER_HOOK)};
    registerActiveRun(${JSON.stringify(opts.projectId)}, ${JSON.stringify(opts.runId)});
    process.stdout.write("READY\\n");
    // Keep the event loop alive so SIGINT actually has work to do.
    setInterval(() => {}, 1000);
  `;
  const child = spawn(TSX, ["-e", script], {
    env: { ...process.env, DEEPSEC_DATA_ROOT: opts.dataRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise<void>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.includes("READY")) resolve();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (!buf.includes("READY")) {
        reject(new Error(`child exited before READY (code=${code} signal=${signal})`));
      }
    });
  });
  return Promise.resolve({ child, ready });
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit within ${timeoutMs}ms (hang)`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function writeRunningMeta(opts: { dataRoot: string; projectId: string; runId: string }): void {
  const runsDir = path.join(opts.dataRoot, opts.projectId, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(runsDir, `${opts.runId}.json`),
    JSON.stringify({
      runId: opts.runId,
      projectId: opts.projectId,
      rootPath: "/tmp",
      createdAt: new Date().toISOString(),
      type: "process",
      phase: "running",
      stats: {},
    }),
  );
}

describe("shutdown handler exit path", () => {
  it("exits the process on SIGINT when no other handler is installed", async () => {
    // The regression this guards: attaching a SIGINT listener
    // suppresses Node's default termination. If the listener doesn't
    // call process.exit, the process hangs after Ctrl+C.
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-shutdown-"));
    const projectId = "test-proj";
    const runId = "20260101000000-aaaaaaaaaaaaaaaa";
    writeRunningMeta({ dataRoot, projectId, runId });

    const { child, ready } = await spawnShutdownChild({ dataRoot, projectId, runId });
    await ready;
    child.kill("SIGINT");
    const { code } = await waitForExit(child, 5000);
    expect(code).toBe(130);

    // And the run should have been flipped to error by the handler.
    const meta = JSON.parse(
      fs.readFileSync(path.join(dataRoot, projectId, "runs", `${runId}.json`), "utf-8"),
    );
    expect(meta.phase).toBe("error");
  });

  it("exits the process on SIGTERM when no other handler is installed", async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-shutdown-"));
    const projectId = "test-proj";
    const runId = "20260101000000-bbbbbbbbbbbbbbbb";
    writeRunningMeta({ dataRoot, projectId, runId });

    const { child, ready } = await spawnShutdownChild({ dataRoot, projectId, runId });
    await ready;
    child.kill("SIGTERM");
    const { code } = await waitForExit(child, 5000);
    expect(code).toBe(143);
  });

  it("defers exit when another SIGINT listener is installed", async () => {
    // When another handler is registered (the sandbox shutdown handler
    // in the real CLI), our handler must NOT exit — that handler needs
    // async cleanup time and will exit itself. We simulate the
    // co-listener with a dummy that exits with a sentinel code so the
    // test can tell whose exit path fired.
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepsec-shutdown-"));
    const projectId = "test-proj";
    const runId = "20260101000000-cccccccccccccccc";
    writeRunningMeta({ dataRoot, projectId, runId });

    const script = `
      import { registerActiveRun } from ${JSON.stringify(REGISTER_HOOK)};
      registerActiveRun(${JSON.stringify(projectId)}, ${JSON.stringify(runId)});
      // Install a co-listener that takes ownership of exit, like the
      // sandbox shutdown handler does in production.
      process.on("SIGINT", () => {
        // Give the core handler a chance to run first, then exit
        // with a sentinel code that proves WE owned the exit path.
        setTimeout(() => process.exit(42), 50);
      });
      process.stdout.write("READY\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(TSX, ["-e", script], {
      env: { ...process.env, DEEPSEC_DATA_ROOT: dataRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (c) => {
        buf += c.toString();
        if (buf.includes("READY")) resolve();
      });
      child.on("error", reject);
    });
    child.kill("SIGINT");
    const { code } = await waitForExit(child, 5000);
    // Sentinel proves the OTHER listener exited the process, not ours.
    expect(code).toBe(42);

    // And the run was still flipped to error by the core handler.
    const meta = JSON.parse(
      fs.readFileSync(path.join(dataRoot, projectId, "runs", `${runId}.json`), "utf-8"),
    );
    expect(meta.phase).toBe("error");
  });
});
