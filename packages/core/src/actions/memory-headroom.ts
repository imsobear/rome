import { readFileSync } from "node:fs";
import { join } from "node:path";

/** How much memory the instance can still take before it swaps or is killed. */
export interface MemoryHeadroom {
  /** Which cgroup version supplied the reading. */
  source: "cgroup-v2" | "cgroup-v1";
  /** The memory limit the container runs under, in bytes. */
  limitBytes: number;
  /** Bytes still allocatable under that limit. Reclaimable file cache counts
   * as available, since the kernel drops it before it swaps anonymous memory. */
  availableBytes: number;
}

export type MemoryHeadroomReader = () => MemoryHeadroom | null;

/** cgroup v1 reports "no limit" as a value near the address-space maximum. */
const CGROUP_V1_UNLIMITED = 2 ** 60;

/**
 * Reads the container's memory headroom from its cgroup limit (v2, then v1).
 * Returns null when no cgroup limit applies: the desktop app and a bare host
 * have no limit to measure against, and the host's free-page count understates
 * what is really available, so no reading is better than a misleading one.
 */
export function readMemoryHeadroom(cgroupRoot = "/sys/fs/cgroup"): MemoryHeadroom | null {
  return readCgroupV2(cgroupRoot) ?? readCgroupV1(cgroupRoot);
}

function readCgroupV2(root: string): MemoryHeadroom | null {
  const limit = readNumber(join(root, "memory.max"));
  const current = readNumber(join(root, "memory.current"));
  if (limit === null || current === null) return null;
  const inactiveFile = readStat(join(root, "memory.stat"), "inactive_file") ?? 0;
  return headroom("cgroup-v2", limit, current - inactiveFile);
}

function readCgroupV1(root: string): MemoryHeadroom | null {
  const limit = readNumber(join(root, "memory", "memory.limit_in_bytes"));
  const usage = readNumber(join(root, "memory", "memory.usage_in_bytes"));
  if (limit === null || usage === null || limit >= CGROUP_V1_UNLIMITED) return null;
  const inactiveFile = readStat(join(root, "memory", "memory.stat"), "total_inactive_file") ?? 0;
  return headroom("cgroup-v1", limit, usage - inactiveFile);
}

function headroom(
  source: MemoryHeadroom["source"],
  limitBytes: number,
  usedBytes: number,
): MemoryHeadroom {
  return {
    source,
    limitBytes,
    availableBytes: Math.max(0, Math.min(limitBytes, limitBytes - usedBytes)),
  };
}

/** A whole number from a one-value cgroup file; null for a missing file or
 * for the literal `max`, which means no limit. */
function readNumber(path: string): number | null {
  const text = readText(path);
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

function readStat(path: string, key: string): number | null {
  const text = readText(path);
  if (text === null) return null;
  for (const line of text.split("\n")) {
    const [name, value] = line.split(" ");
    if (name === key) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
