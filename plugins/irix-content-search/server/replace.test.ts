import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReplaceInput } from "../shared/rpc.js";
import { replaceInFiles } from "./replace.js";
import { resolveRgBinary } from "./rg-binary.js";

const RG = resolveRgBinary();

describe.skipIf(!RG)("replaceInFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "irix-replace-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, content: string | Buffer) {
    writeFileSync(path.join(dir, name), content);
  }
  function file(name: string, lines: number[]) {
    const st = statSync(path.join(dir, name));
    return { path: name, mtimeMs: st.mtimeMs, size: st.size, lines };
  }
  function input(files: ReplaceInput["files"], extra: Partial<ReplaceInput> = {}): ReplaceInput {
    return {
      cwd: dir,
      query: "foo",
      caseSensitive: false,
      regex: false,
      wholeWord: false,
      replacement: "bar",
      files,
      ...extra,
    };
  }
  const run = (i: ReplaceInput) => replaceInFiles(RG as string, i);

  it("replaces every match on the chosen lines and leaves other lines alone", async () => {
    write("a.txt", "foo one\nfoo foo two\nfoo three\n");
    const [result] = await run(input([file("a.txt", [2, 3])]));
    expect(result).toMatchObject({ status: "replaced", count: 3 });
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("foo one\nbar bar two\nbar three\n");
  });

  it("keeps CRLF line endings and a BOM", async () => {
    write(
      "a.txt",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("foo a\r\nfoo b\r\nfoo")]),
    );
    await run(input([file("a.txt", [1, 2, 3])]));
    const out = readFileSync(path.join(dir, "a.txt"));
    expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(out.subarray(3).toString("utf8")).toBe("bar a\r\nbar b\r\nbar");
  });

  it("replaces with capture groups in regex mode and literally otherwise", async () => {
    write("a.txt", "id=12\n");
    await run(
      input([file("a.txt", [1])], { query: "id=([0-9]+)", regex: true, replacement: "n-$1" }),
    );
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("n-12\n");
    write("b.txt", "foo\n");
    await run(input([file("b.txt", [1])], { replacement: "$1 cost" }));
    expect(readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("$1 cost\n");
  });

  it("skips a file that changed after the search and still does the others", async () => {
    write("a.txt", "foo\n");
    write("b.txt", "foo\n");
    const stale = file("a.txt", [1]);
    write("a.txt", "foo changed\n");
    utimesSync(path.join(dir, "a.txt"), new Date(), new Date(Date.now() + 5000));
    const results = await run(input([stale, file("b.txt", [1])]));
    expect(results[0]).toMatchObject({
      status: "skipped",
      reason: "Changed on disk since the search",
    });
    expect(results[1]).toMatchObject({ status: "replaced", count: 1 });
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("foo changed\n");
  });

  it("skips files that are not UTF-8", async () => {
    write("a.txt", Buffer.from([0x66, 0x6f, 0x6f, 0x20, 0xe9, 0x0a]));
    const [result] = await run(input([file("a.txt", [1])]));
    expect(result).toMatchObject({ status: "skipped", reason: "Not a UTF-8 file" });
  });

  it("refuses paths outside the folder and inside .git", async () => {
    write("a.txt", "foo\n");
    const base = file("a.txt", [1]);
    const results = await run(
      input([
        { ...base, path: "../a.txt" },
        { ...base, path: ".git/config" },
      ]),
    );
    expect(results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
  });
});
