const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "jimaku-player-reloaded.user.js");
const src = fs.readFileSync(SRC, "utf8");
const OUT = path.join(require("os").tmpdir(), "jimaku-pure-fns.js");

// Slice the pure functions out of the userscript (no DOM needed) and load them.
function grab(name) {
  const head = "\n  function " + name + "(";
  const i = src.indexOf(head);
  if (i < 0) throw new Error("missing function " + name);
  const j = src.indexOf("\n  }\n", i);
  if (j < 0) throw new Error("unterminated function " + name);
  return src.slice(i, j + 5);
}
function grabConst(name) {
  const head = "\n  const " + name + " =";
  const i = src.indexOf(head);
  if (i < 0) throw new Error("missing const " + name);
  const j = src.indexOf(";\n", i);
  return src.slice(i, j + 2);
}

const fns = [
  "normalize",
  "parseTime",
  "parseSRT",
  "parseVTT",
  "parseASS",
  "parseByName",
  "findSubIndex",
  "sortFiles",
  "escapeHtml",
];
let code = "const state = { subtitles: [] };\n";
code += grabConst("stripAss");
code += grabConst("formatSize");
for (const n of fns) code += grab(n);
code += "\nmodule.exports = { " + fns.join(", ") + ", formatSize, state };\n";
fs.writeFileSync(OUT, code);

const M = require(OUT);
let fail = 0;
const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.log("FAIL  " + label + "\n  got  " + a + "\n  want " + b);
    fail++;
  } else console.log("ok    " + label);
};

const srt =
  "\uFEFF1\r\n00:00:01,500 --> 00:00:03,000\r\n\u3053\u3093\u306B\u3061\u306F\r\n\r\n" +
  "2\r\n00:00:04,000 --> 00:00:05,250 X1:1\r\n<i>\u307E\u305F</i>\u306D\r\n";
eq(
  M.parseSRT(srt),
  [
    { start: 1500, end: 3000, text: "\u3053\u3093\u306B\u3061\u306F" },
    { start: 4000, end: 5250, text: "\u307E\u305F\u306D" },
  ],
  "SRT: BOM + CRLF + comma ms + trailing coords + inline tags",
);

const vtt = "WEBVTT\n\nNOTE something\n\n00:00:02.000 --> 00:00:04.000\n\u30C6\u30B9\u30C8\n";
eq(M.parseVTT(vtt), [{ start: 2000, end: 4000, text: "\u30C6\u30B9\u30C8" }], "VTT: header + NOTE stripped");

const ass =
  "[Script Info]\nTitle: x\n\n[Events]\n" +
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
  "Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\pos(1,2)}\u524D\u534A\\N\u5F8C\u534A\n" +
  "Dialogue: 0,0:00:03.00,0:00:04.00,Sign,,0,0,0,,\u770B\u677F, \u3053\u308C\u3082\u672C\u6587\n";
eq(
  M.parseASS(ass),
  [
    { start: 1000, end: 2500, text: "\u524D\u534A\n\u5F8C\u534A" },
    { start: 3000, end: 4000, text: "\u770B\u677F, \u3053\u308C\u3082\u672C\u6587" },
  ],
  "ASS: override tags stripped, \\N -> newline, commas kept in Text field",
);

eq(M.parseByName(ass, "a.ass").length, 2, "dispatch by extension (.ass)");
eq(M.parseByName(srt, "a.srt").length, 2, "dispatch by extension (.srt)");
eq(M.parseASS("[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,,,0,0,0,,x\n"), [], "ASS with no Format line is skipped, not misparsed");

// Overlapping cues: the case a plain binary search over [start,end] gets wrong.
M.state.subtitles = [
  { start: 0, end: 20000, text: "sign" },
  { start: 1000, end: 2000, text: "line A" },
  { start: 5000, end: 6000, text: "line B" },
];
eq(M.findSubIndex(1500), 1, "overlap: picks the latest-started active cue");
eq(M.findSubIndex(5500), 2, "overlap: later cue inside a long sign");
eq(M.findSubIndex(3000), 0, "overlap: falls back to the still-active sign");
eq(M.findSubIndex(50000), -1, "past the end -> nothing showing");
eq(M.findSubIndex(-5), -1, "before the start -> nothing showing");
M.state.subtitles = [];
eq(M.findSubIndex(0), -1, "empty list -> nothing showing");

eq(
  M.sortFiles([{ name: "x.zip" }, { name: "x.srt" }, { name: "[Web] y.ass" }], true).map((f) => f.name),
  ["[Web] y.ass", "x.srt", "x.zip"],
  "file ranking: ASS+WEB first, archives last",
);
eq(M.escapeHtml("<a \"b\" & 'c'>"), "&lt;a &quot;b&quot; &amp; &#39;c&#39;&gt;", "html escaping");
eq(M.formatSize(2048), "2.0 KB", "size formatting");

console.log(fail ? "\n" + fail + " FAILED" : "\nall passed");
process.exit(fail ? 1 : 0);
