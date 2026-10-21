const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "jimaku-anikoto.user.js"), "utf8");

// Evaluate the DOM-free block between the pure:start / pure:end markers.
const start = src.indexOf("/* pure:start");
const end = src.indexOf("/* pure:end */");
if (start < 0 || end < 0) throw new Error("pure:start / pure:end markers missing");
const names = ["parseTime", "parseSRT", "parseASS", "parseSubs", "activeSubs", "sortFiles", "isSubFile", "esc", "formatSize"];
const M = new Function(`${src.slice(start, end)}\nreturn { ${names.join(", ")} };`)();

let fail = 0;
const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.log("FAIL  " + label + "\n  got  " + a + "\n  want " + b);
    fail++;
  } else console.log("ok    " + label);
};

eq(M.parseTime("00:01:02,500"), 62500, "parseTime: h:m:s,ms");
eq(M.parseTime("01:02.25"), 62250, "parseTime: m:s.ms");
eq(M.parseTime("0:00:01.00"), 1000, "parseTime: ASS centiseconds");
eq(M.parseTime("garbage"), 0, "parseTime: garbage");

const srt =
  "﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nこんにちは\r\n\r\n" +
  "2\r\n00:00:04,000 --> 00:00:05,250 X1:1\r\n<i>また</i>ね\r\n";
eq(
  M.parseSRT(srt),
  [
    { start: 1500, end: 3000, text: "こんにちは" },
    { start: 4000, end: 5250, text: "またね" },
  ],
  "SRT: BOM + CRLF + comma ms + trailing coords + inline tags",
);

const vtt =
  "WEBVTT\n\nNOTE something\nspanning two lines\n\n" +
  "00:00:02.000 --> 00:00:04.000 align:start\n<c.ja>テスト</c>\n\n" +
  "NOTE another\n\ncue-id\n00:00:05.000 --> 00:00:06.000\n二つ目\n";
eq(
  M.parseSubs(vtt, "x.vtt"),
  [
    { start: 2000, end: 4000, text: "テスト" },
    { start: 5000, end: 6000, text: "二つ目" },
  ],
  "VTT: header + NOTE blocks skipped, cues after a NOTE kept, cue settings ignored",
);

const ass =
  "[Script Info]\nTitle: x\n\n[V4+ Styles]\nFormat: Name\nStyle: Default\n\n[Events]\n" +
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
  "Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\pos(1,2)}前半\\N後半\n" +
  "Comment: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,コメント\n" +
  "Dialogue: 0,0:00:01.50,0:00:04.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}\n" +
  "Dialogue: 0,0:00:03.00,0:00:04.00,Sign,,0,0,0,,看板, これも本文\n";
const assSubs = M.parseSubs(ass, "x.ass");
eq(
  assSubs,
  [
    { start: 1000, end: 2500, text: "前半\n後半" },
    { start: 3000, end: 4000, text: "看板, これも本文" },
  ],
  "ASS: tags stripped, \\N newline, commas in Text, comments + drawings skipped",
);

const overlap = [
  { start: 0, end: 10000, text: "sign" },
  { start: 2000, end: 3000, text: "a" },
  { start: 4000, end: 5000, text: "b" },
];
eq(M.activeSubs(overlap, 2500).map((s) => s.text), ["sign", "a"], "activeSubs: overlapping lines both shown");
eq(M.activeSubs(overlap, 11000), [], "activeSubs: nothing after the end");

eq(
  M.sortFiles(
    [{ name: "ep1.zip" }, { name: "ep1.srt" }, { name: "ep1 [WEB].ass" }],
    true,
  ).map((f) => f.name),
  ["ep1 [WEB].ass", "ep1.srt", "ep1.zip"],
  "sortFiles: ASS + WEB first, archives last",
);
eq(M.isSubFile("a.SSA"), true, "isSubFile: case-insensitive");
eq(M.esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;", "esc");
eq(M.formatSize(2048), "2.0 KB", "formatSize");

console.log(fail ? `\n${fail} failing` : "\nall passing");
process.exit(fail ? 1 : 0);
