import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { readMemoryHeadroom } from "./memory-headroom.js";

describe("readMemoryHeadroom", () => {
  const roots: string[] = [];

  function cgroupRoot(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "rome-cgroup-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reads a cgroup v2 limit and counts reclaimable file cache as free", () => {
    const root = cgroupRoot({
      "memory.max": "4294967296\n",
      "memory.current": "3221225472\n",
      "memory.stat":
        "anon 2147483648\nfile 1073741824\ninactive_file 536870912\nactive_file 536870912\n",
    });

    expect(readMemoryHeadroom(root)).toEqual({
      source: "cgroup-v2",
      limitBytes: 4_294_967_296,
      availableBytes: 4_294_967_296 - (3_221_225_472 - 536_870_912),
    });
  });

  it("reads a cgroup v1 limit", () => {
    const root = cgroupRoot({
      "memory/memory.limit_in_bytes": "4294967296\n",
      "memory/memory.usage_in_bytes": "2147483648\n",
      "memory/memory.stat": "total_inactive_file 1073741824\ncache 1073741824\n",
    });

    expect(readMemoryHeadroom(root)).toEqual({
      source: "cgroup-v1",
      limitBytes: 4_294_967_296,
      availableBytes: 4_294_967_296 - (2_147_483_648 - 1_073_741_824),
    });
  });

  it("reports nothing when the cgroup has no limit", () => {
    const root = cgroupRoot({ "memory.max": "max\n", "memory.current": "1024\n" });

    expect(readMemoryHeadroom(root)).toBeNull();
  });

  it("reports nothing when a cgroup v1 limit is the unlimited sentinel", () => {
    const root = cgroupRoot({
      "memory/memory.limit_in_bytes": "9223372036854771712\n",
      "memory/memory.usage_in_bytes": "1024\n",
    });

    expect(readMemoryHeadroom(root)).toBeNull();
  });

  it("reports nothing when there is no cgroup at all", () => {
    expect(readMemoryHeadroom(cgroupRoot({}))).toBeNull();
  });

  it("never reports negative headroom", () => {
    const root = cgroupRoot({
      "memory.max": "1024\n",
      "memory.current": "4096\n",
      "memory.stat": "inactive_file 0\n",
    });

    expect(readMemoryHeadroom(root)?.availableBytes).toBe(0);
  });
});
