import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function readCheckState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (!state || typeof state.checkedAt !== "string" || !["success", "error"].includes(state.status)) return null;
    return {
      checkedAt: state.checkedAt,
      status: state.status,
      message: typeof state.message === "string" ? state.message : ""
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeCheckState(statePath, state) {
  const temporaryPath = path.join(path.dirname(statePath), `.results-check-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, statePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
