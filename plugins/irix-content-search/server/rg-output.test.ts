import { describe, expect, it } from "vitest";
import { LINE_WINDOW, createRgOutputParser, trimLineAroundMatch } from "./rg-output.js";

// Captured from a real `rg --json needle .` run.
const CRLF =
  '{"type":"match","data":{"path":{"text":"./crlf.txt"},"lines":{"text":"first needle here\\r\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}\n';
const JP =
  '{"type":"match","data":{"path":{"text":"./jp.txt"},"lines":{"text":"日本語 needle tail\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":10,"end":16}]}}\n';
const ODD_NAME =
  '{"type":"match","data":{"path":{"text":"./my file: é日.txt"},"lines":{"text":"a needle b\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}\n';
const BAD_BYTES =
  '{"type":"match","data":{"path":{"text":"./bad.bin"},"lines":{"bytes":"YmFkIP/+IG5lZWRsZQo="},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":7,"end":13}]}}\n';
const BEGIN = '{"type":"begin","data":{"path":{"text":"./jp.txt"}}}\n';
const END =
  '{"type":"end","data":{"path":{"text":"./jp.txt"},"binary_offset":null,"stats":{"elapsed":{"secs":0,"nanos":4750,"human":"0.000005s"},"searches":1,"searches_with_match":1,"bytes_searched":22,"bytes_printed":248,"matched_lines":1,"matches":1}}}\n';
const SUMMARY =
  '{"data":{"elapsed_total":{"human":"0.002006s","nanos":2006375,"secs":0},"stats":{"bytes_printed":1003,"bytes_searched":74,"elapsed":{"human":"0.000041s","nanos":41417,"secs":0},"matched_lines":4,"matches":4,"searches":4,"searches_with_match":4}},"type":"summary"}\n';
const CONTEXT =
  '{"type":"context","data":{"path":{"text":"./jp.txt"},"lines":{"text":"ctx\\n"},"line_number":2,"absolute_offset":5,"submatches":[]}}\n';

describe("createRgOutputParser", () => {
  it("emits only match messages", () => {
    const p = createRgOutputParser();
    const out = p.push(BEGIN + CONTEXT + JP + END + SUMMARY);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("jp.txt");
  });

  it("converts UTF-8 byte offsets to UTF-16 offsets and column", () => {
    const [m] = createRgOutputParser().push(JP);
    expect(m.text).toBe("日本語 needle tail");
    expect(m.ranges).toEqual([{ start: 4, end: 10 }]);
    expect(m.column).toBe(5);
    expect(m.line).toBe(1);
  });

  it("drops the CRLF terminator", () => {
    const [m] = createRgOutputParser().push(CRLF);
    expect(m.text).toBe("first needle here");
    expect(m.ranges).toEqual([{ start: 6, end: 12 }]);
  });

  it("keeps spaces, colons and non-ASCII in the path", () => {
    const [m] = createRgOutputParser().push(ODD_NAME);
    expect(m.path).toBe("my file: é日.txt");
  });

  it("normalizes backslashes and the leading ./", () => {
    const line = JP.replace("./jp.txt", ".\\\\dir\\\\jp.txt");
    const [m] = createRgOutputParser().push(line);
    expect(m.path).toBe("dir/jp.txt");
  });

  it("decodes lines.bytes lossily without throwing", () => {
    const [m] = createRgOutputParser().push(BAD_BYTES);
    expect(m.text).toBe("bad �� needle");
    expect(m.ranges).toEqual([{ start: 7, end: 13 }]);
    expect(m.column).toBe(8);
  });

  it("decodes path.bytes", () => {
    const line = BAD_BYTES.replace('{"text":"./bad.bin"}', '{"bytes":"Li9iYWQuYmlu"}');
    const [m] = createRgOutputParser().push(line);
    expect(m.path).toBe("bad.bin");
  });

  it("joins a JSON line split across chunks", () => {
    const p = createRgOutputParser();
    const cut = 40;
    expect(p.push(CRLF.slice(0, cut))).toEqual([]);
    expect(p.push(CRLF.slice(cut))).toHaveLength(1);
  });

  it("joins a multi-byte character split across chunks", () => {
    const p = createRgOutputParser();
    const buf = Buffer.from(JP, "utf8");
    const at = buf.indexOf(Buffer.from("日")) + 1; // inside the 3-byte character
    expect(p.push(buf.subarray(0, at))).toEqual([]);
    const out = p.push(buf.subarray(at));
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("日本語 needle tail");
  });

  it("skips malformed lines", () => {
    const p = createRgOutputParser();
    expect(p.push('{"type":"mat\n' + JP)).toHaveLength(1);
  });

  it("flushes a trailing partial line on end()", () => {
    const p = createRgOutputParser();
    expect(p.push(JP.trimEnd())).toEqual([]);
    expect(p.end()).toHaveLength(1);
  });

  it("returns nothing from end() for an empty remainder", () => {
    const p = createRgOutputParser();
    p.push(JP);
    expect(p.end()).toEqual([]);
  });
});

describe("trimLineAroundMatch", () => {
  it("returns a short line unchanged", () => {
    const r = [{ start: 2, end: 4 }];
    expect(trimLineAroundMatch("abcdef", r)).toEqual({ text: "abcdef", ranges: r });
  });

  it("windows a huge line with the match at the end", () => {
    const line = "x".repeat(2_000_000) + "needle";
    const start = line.length - 6;
    const out = trimLineAroundMatch(line, [{ start, end: start + 6 }]);
    expect(out.text.length).toBeLessThanOrEqual(LINE_WINDOW + 2);
    expect(out.ranges).toHaveLength(1);
    expect(out.text.slice(out.ranges[0].start, out.ranges[0].end)).toBe("needle");
  });

  it("windows a match in the middle and marks both sides", () => {
    const line = "a".repeat(1000) + "needle" + "b".repeat(1000);
    const out = trimLineAroundMatch(line, [{ start: 1000, end: 1006 }]);
    expect(out.text.length).toBeLessThanOrEqual(LINE_WINDOW + 2);
    expect(out.text.startsWith("…")).toBe(true);
    expect(out.text.endsWith("…")).toBe(true);
    expect(out.text.slice(out.ranges[0].start, out.ranges[0].end)).toBe("needle");
  });

  it("clamps a match longer than the window to the visible text", () => {
    const line = "ab" + "m".repeat(1000) + "cd";
    const out = trimLineAroundMatch(line, [{ start: 2, end: 1002 }]);
    expect(out.ranges).toHaveLength(1);
    expect(out.text.slice(out.ranges[0].start, out.ranges[0].end)).toBe(
      "m".repeat(out.ranges[0].end - out.ranges[0].start),
    );
    expect(out.ranges[0].start).toBe(2);
    expect(out.ranges[0].end).toBe(out.text.length - 1);
  });

  it("drops a range that starts after the window", () => {
    const line = "needle" + "a".repeat(1000) + "needle";
    const out = trimLineAroundMatch(line, [
      { start: 0, end: 6 },
      { start: 1006, end: 1012 },
    ]);
    expect(out.ranges).toEqual([{ start: 0, end: 6 }]);
  });

  it("drops ranges that fall outside the window", () => {
    const line = "needle" + "a".repeat(1000) + "needle";
    const out = trimLineAroundMatch(line, [
      { start: 0, end: 6 },
      { start: 1006, end: 1012 },
    ]);
    expect(out.ranges).toHaveLength(1);
    expect(out.text.slice(out.ranges[0].start, out.ranges[0].end)).toBe("needle");
  });

  it("keeps a huge line with thousands of submatches fast and correct", () => {
    const unit = "日needle ";
    const text = unit.repeat(250_000); // about 2.2 million characters
    const submatches = [] as { match: { text: string }; start: number; end: number }[];
    for (let i = 0; i < 250_000; i++) {
      const start = i * Buffer.byteLength(unit) + 3;
      submatches.push({ match: { text: "needle" }, start, end: start + 6 });
    }
    const msg =
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "./min.js" },
          lines: { text: text + "\n" },
          line_number: 7,
          submatches,
        },
      }) + "\n";
    const began = performance.now();
    const out = createRgOutputParser().push(msg);
    expect(performance.now() - began).toBeLessThan(1000);
    expect(out).toHaveLength(1);
    expect(out[0].text.length).toBeLessThanOrEqual(LINE_WINDOW + 2);
    expect(out[0].column).toBe(2);
    expect(out[0].ranges[0]).toEqual({ start: 1, end: 7 });
  });

  it("looks for a newline only in new text, so a long line in many chunks costs linear work", () => {
    const line =
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "./big.min.js" },
          lines: { text: `${"x".repeat(3_000_000)} needle\n` },
          line_number: 1,
          submatches: [{ match: { text: "needle" }, start: 3_000_001, end: 3_000_007 }],
        },
      }) + "\n";
    const whole = createRgOutputParser().push(line);

    const stats = { scanned: 0 };
    const chunked = createRgOutputParser(stats);
    const chunkSize = 64 * 1024;
    const out = [];
    for (let at = 0; at < line.length; at += chunkSize) {
      out.push(...chunked.push(line.slice(at, at + chunkSize)));
    }
    out.push(...chunked.end());

    expect(out).toEqual(whole);
    expect(out).toHaveLength(1);
    // Rescanning the whole buffer on each of the 46 chunks reads about 23 times the line.
    expect(stats.scanned).toBeGreaterThanOrEqual(line.length);
    expect(stats.scanned).toBeLessThanOrEqual(line.length + 1);
  });
});
