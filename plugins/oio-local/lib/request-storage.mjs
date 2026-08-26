import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import { JourneyHold } from "./local-state.mjs";

const requestDirectories = new Set(["deliverables", "records", "reviews", "source"]);

function unsafeRequestStorage(error) {
  if (error instanceof JourneyHold) return error;
  return new JourneyHold(
    "REQUEST_DIRECTORY_UNSAFE",
    "The OIO Local request storage cannot be used safely.",
    "Restore the request directories as real directories inside this project, then retry.",
    { cause: String(error?.message ?? error) },
  );
}

async function requireExactDirectory(target, expectedRealPath) {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`unsafe directory: ${target}`);
  }
  if (await realpath(target) !== expectedRealPath) {
    throw new Error(`redirected directory: ${target}`);
  }
}

export function requestRoot(project, requestId) {
  return path.join(path.resolve(project), ".oio-local", "requests", requestId);
}

export async function ensureRequestContainer(project, { create = false } = {}) {
  try {
    const absoluteProject = path.resolve(project);
    const realProject = await realpath(absoluteProject);
    const state = path.join(absoluteProject, ".oio-local");
    const requests = path.join(state, "requests");
    await requireExactDirectory(state, path.join(realProject, ".oio-local"));
    if (create) {
      try {
        await mkdir(requests);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    await requireExactDirectory(requests, path.join(realProject, ".oio-local", "requests"));
    return requests;
  } catch (error) {
    throw unsafeRequestStorage(error);
  }
}

export async function ensureRequestDirectory(project, requestId, name, { create = false } = {}) {
  try {
    if (!requestDirectories.has(name)) throw new Error(`unsupported request directory: ${name}`);
    const absoluteProject = path.resolve(project);
    const realProject = await realpath(absoluteProject);
    const container = await ensureRequestContainer(project);
    const root = path.join(container, requestId);
    const expectedRoot = path.join(realProject, ".oio-local", "requests", requestId);
    await requireExactDirectory(root, expectedRoot);
    const directory = path.join(root, name);
    if (create) {
      try {
        await mkdir(directory);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    await requireExactDirectory(directory, path.join(expectedRoot, name));
    return directory;
  } catch (error) {
    throw unsafeRequestStorage(error);
  }
}

export async function writeRequestFile(directory, filename, contents) {
  const target = path.join(directory, filename);
  try {
    if (path.basename(filename) !== filename) throw new Error("nested filename");
    const parent = await lstat(directory);
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("unsafe parent");
    const existing = await lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Error("unsafe target");
    }
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
    return target;
  } catch (error) {
    throw unsafeRequestStorage(error);
  }
}
