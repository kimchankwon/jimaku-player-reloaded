// ==UserScript==
// @name         Jimaku Player Reloaded (Anikoto)
// @namespace    https://github.com/mgp25/jimaku-player-reloaded
// @version      3.0.0-anikoto
// @description  Browse, download, and align Japanese subtitles on Anikoto using jimaku.cc (rikaikun-friendly)
// @author       mgp25 (adapted for Anikoto)
// @match        *://anikoto.tv/*
// @match        *://*.anikoto.tv/*
// @match        *://anikoto.cz/*
// @match        *://*.anikoto.cz/*
// @match        *://anikoto.net/*
// @match        *://*.anikoto.net/*
// @match        *://anikoto.me/*
// @match        *://*.anikoto.me/*
// @match        *://anikototv.to/*
// @match        *://*.anikototv.to/*
// @match        *://anikototv.se/*
// @match        *://*.anikototv.se/*
// @match        *://anikoto.to/*
// @match        *://*.anikoto.to/*
// @match        *://anikoto.bz/*
// @match        *://*.anikoto.bz/*
// @match        *://vidwish.live/*
// @match        *://megaplay.buzz/*
// @match        *://vidtube.site/*
// @match        *://*.kwik.cx/*
// @match        *://mewcdn.online/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      jimaku.cc
// @run-at       document-start
// ==/UserScript==
//
// Based on the original Jimaku Player by sheodox + Jimaku Player Reloaded by mgp25
// Adapted for Anikoto players (JW Player / Plyr / plain video)
/* eslint-disable no-undef */
(function () {
  "use strict";

  const log = (...a) => console.log("[jimaku-anikoto]", ...a);

  /* ------------------------------------------------------------------ *
   * Settings. GM storage is shared by anikoto and every player iframe,
   * so the API key only has to be entered once. Older versions used
   * per-domain localStorage; those values are still read as a fallback.
   * ------------------------------------------------------------------ */
  const hasGM = typeof GM_getValue === "function" && typeof GM_setValue === "function";
  function load(key, fallback) {
    try {
      const v = hasGM ? GM_getValue(key) : undefined;
      if (v !== undefined) return v;
      const raw = localStorage.getItem("jp:" + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      if (hasGM) GM_setValue(key, value);
      else localStorage.setItem("jp:" + key, JSON.stringify(value));
    } catch (e) {
      console.warn("[jimaku-anikoto] could not save", key, e);
    }
  }

  const KEYS = {
    apiKey: ["jimaku-api-key", ""],
    preferAss: ["jimaku-prefer-ass", true],
    fontScale: ["jimaku-font-scale", 1],
    position: ["jimaku-position", "bottom"],
    nativeMode: ["jimaku-native-mode", "below"], // below | hidden | player
    pauseOnHover: ["jimaku-pause-on-hover", true],
    hideCursor: ["jimaku-hide-cursor", true],
    entryCache: ["jimaku-entry-cache", {}],
    alignByShow: ["jimaku-alignment-by-show", {}],
  };
  const cfg = {};
  for (const [k, [key, def]] of Object.entries(KEYS)) cfg[k] = load(key, def);
  const setCfg = (k, v) => {
    cfg[k] = v;
    save(KEYS[k][0], v);
  };

  const state = {
    subs: [],
    file: "",
    offset: 0, // added to video time before looking up a line; positive = lines show earlier
    enabled: true,
    timeMs: 0,
    lastSub: null,
    hoverPaused: false,
    detected: { slug: "", title: "", episode: null },
    entries: [],
    entry: null,
    files: [],
    query: null, // search drafts; null = use the detected value
    episode: null,
    open: false,
    tab: "load",
    busy: "",
    error: "",
    autoSearched: false,
  };

  /* pure:start — no DOM below this line until pure:end (see scripts/test-anikoto.js) */
  const normalize = (text) => String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  function parseTime(s) {
    const parts = String(s || "").replace(/\s+/g, "").replace(",", ".").split(":");
    if (parts.length < 2) return 0;
    return Math.round(parts.reduce((acc, p) => acc * 60 + (parseFloat(p) || 0), 0) * 1000);
  }

  // Strips ASS override tags, HTML-ish tags (<i>, <c.ja>) and turns \N into newlines.
  const cleanCue = (t) =>
    t
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\[Nn]/g, "\n")
      .replace(/\\h/g, " ")
      .replace(/<[^>]+>/g, "")
      .trim();

  // SRT and WebVTT: the VTT header, NOTE and STYLE blocks have no "-->" and are skipped.
  function parseSRT(text) {
    const subs = [];
    for (const block of normalize(text).split(/\n\s*\n/)) {
      const lines = block.split("\n");
      const ti = lines.findIndex((l, i) => i < 3 && l.includes("-->"));
      if (ti < 0) continue;
      const [a, b] = lines[ti].split("-->");
      const start = parseTime(a);
      const end = parseTime(b.trim().split(/\s+/)[0]);
      const cue = cleanCue(lines.slice(ti + 1).join("\n"));
      if (cue && end > start) subs.push({ start, end, text: cue });
    }
    return subs.sort((x, y) => x.start - y.start);
  }

  function parseASS(text) {
    const subs = [];
    let inEvents = false;
    let fields = [];
    for (const raw of normalize(text).split("\n")) {
      const line = raw.trim();
      const lower = line.toLowerCase();
      if (/^\[.*\]$/.test(line)) {
        inEvents = lower === "[events]";
      } else if (!inEvents) {
        continue;
      } else if (lower.startsWith("format:")) {
        fields = lower.slice(7).split(",").map((f) => f.trim());
      } else if (lower.startsWith("dialogue:") && fields.length) {
        // The last field (Text) may itself contain commas.
        const parts = line.slice(9).split(",");
        const vals = parts.slice(0, fields.length - 1).concat(parts.slice(fields.length - 1).join(","));
        const field = (name) => (vals[fields.indexOf(name)] || "").trim();
        if (/\\p[1-9]/.test(field("text"))) continue; // vector drawing, not dialogue
        const start = parseTime(field("start"));
        const end = parseTime(field("end"));
        const cue = cleanCue(field("text"));
        if (cue && end > start) subs.push({ start, end, text: cue });
      }
    }
    return subs.sort((x, y) => x.start - y.start);
  }

  const parseSubs = (text, name) => (/\.(ass|ssa)$/i.test(name) ? parseASS(text) : parseSRT(text));

  // Every line on screen at time t (ASS signs often overlap dialogue).
  const activeSubs = (subs, t) => subs.filter((s) => t >= s.start && t <= s.end);

  const isSubFile = (name) => /\.(srt|vtt|ass|ssa)$/i.test(name);

  function scoreFile(name, preferAss) {
    const n = name.toLowerCase();
    let s = 0;
    if (preferAss && /\.(ass|ssa)$/.test(n)) s += 5;
    if (/web|crunchy|amazon|netflix|subsplease|erai-raws/.test(n)) s += 3;
    if (/\.srt$/.test(n)) s += 1;
    if (!isSubFile(n)) s -= 10;
    return s;
  }
  const sortFiles = (files, preferAss) =>
    [...files].sort((a, b) => scoreFile(b.name, preferAss) - scoreFile(a.name, preferAss));

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]);

  const formatSize = (b) =>
    b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`;
  /* pure:end */

  const formatDate = (s) => (s ? new Date(s).toLocaleDateString() : "");
  const firstLine = (t) => t.split("\n")[0];
  // Shown to the user as a delay (positive = lines later), the inverse of state.offset.
  const fmtDelay = (offset = state.offset) =>
    `${offset > 0 ? "−" : "+"}${Math.abs(offset / 1000).toFixed(2)}s`;

  /* ------------------------------------------------------------------ *
   * Show detection. On anikoto the player lives in a cross-origin
   * iframe whose URL says nothing about the show, so the top page
   * posts its detection down to every iframe.
   * ------------------------------------------------------------------ */
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  let parentDetected = null;
  window.addEventListener("message", (e) => {
    if (e.source === window.parent && e.data && e.data.jimakuDetected) parentDetected = e.data.jimakuDetected;
  });

  function detectShow() {
    // /watch/solo-leveling-ilh08/ep-1, /watch/one-piece-odmau, /anime/x/episode/3
    const m = location.pathname.match(/\/(?:watch|anime)\/([^/]+)(?:\/(?:episode|ep)[-/]?(\d+))?/i);
    const d = { slug: m ? m[1] : "", title: "", episode: m && m[2] ? +m[2] : null };
    if (d.slug) d.title = clean(d.slug.replace(/-[a-z0-9]{4,}$/i, "").replace(/-/g, " "));
    const sources = [
      document.querySelector("h1")?.textContent,
      document.querySelector('meta[property="og:title"]')?.content,
      document.title,
    ];
    for (const s of sources) {
      if (!s) continue;
      d.title ||= clean(s).replace(/\s*[-|•]\s*Anikoto.*$/i, "").replace(/^Watch\s+/i, "");
      const ep = s.match(/\b(?:episode|ep)\.?[\s-]*(\d+)/i);
      if (ep && d.episode == null) d.episode = +ep[1];
    }
    return d;
  }

  function refreshDetection() {
    const own = detectShow();
    if (own.slug) {
      for (const f of document.querySelectorAll("iframe")) f.contentWindow?.postMessage({ jimakuDetected: own }, "*");
    }
    const d = !own.slug && parentDetected ? parentDetected : own;
    const prev = state.detected;
    if (d.slug === prev.slug && d.episode === prev.episode && d.title === prev.title) return;
    state.detected = d;
    if (d.slug && d.slug !== prev.slug) state.offset = cfg.alignByShow[d.slug] ?? 0;
    renderPanel();
  }

  /* ------------------------------------------------------------------ *
   * jimaku.cc
   * ------------------------------------------------------------------ */
  const API = "https://jimaku.cc/api";
  const gmXhr =
    typeof GM_xmlhttpRequest === "function"
      ? GM_xmlhttpRequest
      : typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function"
        ? GM.xmlHttpRequest.bind(GM)
        : null;

  function request(url, auth = true) {
    if (!gmXhr) return Promise.reject(new Error("Your userscript manager doesn't grant GM_xmlhttpRequest; can't reach jimaku.cc."));
    if (auth && !cfg.apiKey) return Promise.reject(new Error("Add your jimaku.cc API key in Settings."));
    return new Promise((resolve, reject) =>
      gmXhr({
        method: "GET",
        url,
        headers: auth ? { Authorization: cfg.apiKey } : {},
        timeout: 20000,
        onload: (r) =>
          r.status >= 200 && r.status < 300
            ? resolve(r.responseText)
            : reject(new Error(r.status === 401 ? "jimaku.cc rejected the API key (HTTP 401)." : `jimaku.cc returned HTTP ${r.status}.`)),
        onerror: () => reject(new Error("Network error contacting jimaku.cc.")),
        ontimeout: () => reject(new Error("jimaku.cc timed out.")),
      }),
    );
  }
  const api = async (path) => JSON.parse(await request(API + path));

  /* ------------------------------------------------------------------ *
   * Player + native captions
   * ------------------------------------------------------------------ */
  const PLAYERS = ".jwplayer, .plyr, .video-js, .art-video-player";
  const NATIVE_CAPTIONS = ".jw-captions, .plyr__captions, .vjs-text-track-display, .art-subtitle";
  // Where the cursor stays visible when "hide cursor" is on: our UI and the player's controls/menus.
  const CURSOR_ZONES = [
    ".jp-ja, #jp-fab, #jp-panel",
    "button, a, input, select, [role=button], [role=slider], [role=menu], [role=menuitem], [role=menuitemradio]",
    ".jw-controlbar, .jw-settings-menu, .jw-display-icon-container",
    ".plyr__controls, .plyr__menu__container, .vjs-control-bar, .vjs-menu, .art-bottom, .art-settings",
  ].join(", ");

  const getVideo = () =>
    document.querySelector(PLAYERS.split(", ").map((p) => p + " video").join(", ")) || document.querySelector("video");
  const findContainer = (v) => v.closest(PLAYERS) || v.closest('[class*="player"]') || v.parentElement;

  function seekTo(ms) {
    const v = getVideo();
    if (v) v.currentTime = Math.max(0, ms) / 1000;
  }

  // Whatever subtitle the player itself is currently showing (its CC must be on).
  // The player's rendering is hidden with opacity, not display/visibility, so innerText still works.
  function readNativeSubs(v) {
    for (const el of document.querySelectorAll(NATIVE_CAPTIONS)) {
      if (ui.host.contains(el)) continue;
      const t = el.innerText.trim();
      if (t) return t;
    }
    for (const track of Array.from(v.textTracks || [])) {
      if (track.mode === "showing" && track.activeCues?.length)
        return cleanCue(Array.from(track.activeCues, (c) => c.text).join("\n"));
    }
    return "";
  }

  /* ------------------------------------------------------------------ *
   * rikaikun. It looks words up with caretRangeFromPoint on window
   * mousemove, so the Japanese line must be real DOM text (no shadow
   * root), on top of the player's click-catching layers, and its
   * mousemove events must be allowed to bubble. Its popup is appended
   * to <body>, which isn't painted in fullscreen, so it's moved into
   * the fullscreen element while fullscreen.
   * ------------------------------------------------------------------ */
  function rikaiVisible() {
    const box = document.getElementById("rikaichan-window")?.shadowRoot?.querySelector("#rikaikun-shadow");
    return !!box && box.style.display !== "none";
  }

  function fixRikaiPopup() {
    const pop = document.getElementById("rikaichan-window");
    if (!pop || !document.body) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const home = fs && !/^(IFRAME|VIDEO)$/.test(fs.tagName) && !fs.contains(document.body) ? fs : document.body;
    if (pop.parentNode !== home) {
      home.appendChild(pop);
      pop.style.cssText = home === document.body ? "" : "position:fixed;left:0;top:0;z-index:2147483647";
    }
    // rikaikun adds the page scroll to its coordinates; cancel that out inside the fullscreen element.
    if (home !== document.body) {
      pop.style.left = -scrollX + "px";
      pop.style.top = -scrollY + "px";
    }
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  const STYLES = `
#jp-host{position:absolute;inset:0;pointer-events:none;z-index:2147483000;container-type:size;
  --jp-accent:#ff4d6d;--jp-line:rgba(255,255,255,.09);--jp-muted:#9ba1b4;
  font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans JP",sans-serif;color:#f3f4f8;text-align:left}
#jp-host *{box-sizing:border-box}

.jp-box{position:absolute;left:4%;right:4%;display:flex;flex-direction:column;align-items:center;gap:.4em;text-align:center}
.jp-top{top:6%}
.jp-bottom{bottom:max(58px,9%)}
.jp-ja,.jp-native{display:none;max-width:100%;white-space:pre-wrap;border-radius:.3em;padding:.1em .5em;
  background:rgba(8,8,12,.5);color:#fff;
  text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 2px 8px rgba(0,0,0,.9)}
.jp-ja.on,.jp-native.on{display:inline-block}
.jp-ja{pointer-events:auto;cursor:text;user-select:text;-webkit-user-select:text;
  font:600 calc(var(--jp-scale,1)*clamp(16px,3cqw,64px))/1.4 "Hiragino Sans","Yu Gothic UI","Yu Gothic",Meiryo,"Noto Sans JP",sans-serif;
  transition:background .15s}
.jp-ja:hover{background:rgba(8,8,12,.75)}
.jp-native{pointer-events:none;color:#ececf1;font:500 calc(var(--jp-scale,1)*clamp(12px,2.1cqw,44px))/1.35 system-ui,"Segoe UI",sans-serif}

#jp-fab{position:absolute;top:12px;right:12px;width:38px;height:38px;padding:0;display:grid;place-items:center;
  border-radius:11px;border:1px solid rgba(255,255,255,.14);background:rgba(14,15,21,.72);backdrop-filter:blur(8px);
  color:#fff;font:600 17px/1 "Hiragino Sans","Yu Gothic UI","Noto Sans JP",sans-serif;cursor:pointer;pointer-events:auto;
  opacity:0;transition:opacity .2s,background .2s,transform .15s}
.jp-container:hover #jp-fab,#jp-fab:focus-visible,#jp-fab.active{opacity:1}
.jw-flag-user-inactive #jp-fab:not(.active),.plyr--hide-controls #jp-fab:not(.active){opacity:0}
#jp-fab:hover{background:var(--jp-accent);transform:translateY(-1px)}
#jp-fab.loaded::after{content:"";position:absolute;right:5px;bottom:5px;width:7px;height:7px;border-radius:50%;
  background:#4ade80;box-shadow:0 0 0 2px rgba(14,15,21,.9)}
#jp-fab.pulse{animation:jp-pulse .9s ease-out}
@keyframes jp-pulse{from{box-shadow:0 0 0 0 rgba(74,222,128,.85)}to{box-shadow:0 0 0 16px rgba(74,222,128,0)}}

#jp-panel{position:absolute;top:58px;right:12px;width:350px;max-width:calc(100% - 24px);max-height:calc(100% - 70px);
  display:none;flex-direction:column;pointer-events:auto;overflow:hidden;
  background:rgba(16,17,24,.93);backdrop-filter:blur(18px);border:1px solid var(--jp-line);border-radius:14px;
  box-shadow:0 20px 50px rgba(0,0,0,.55)}
#jp-panel.open{display:flex;animation:jp-in .16s ease-out}
@keyframes jp-in{from{opacity:0;transform:translateY(-6px)}}
#jp-panel button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;margin:0}
#jp-panel a{color:#ff97aa}
#jp-panel kbd{font:600 10.5px ui-monospace,Consolas,monospace;padding:1px 5px;border-radius:4px;
  background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.12);border-bottom-width:2px}

.jp-head{display:flex;align-items:center;gap:10px;padding:12px 10px 10px 14px}
.jp-logo{flex:none;width:30px;height:30px;display:grid;place-items:center;border-radius:9px;color:#fff;
  background:linear-gradient(135deg,#ff4d6d,#ff8a5c);font:700 16px/1 "Hiragino Sans","Yu Gothic UI","Noto Sans JP",sans-serif}
.jp-title{flex:1;min-width:0;font-weight:650;font-size:14px}
.jp-title small,.jp-ellipsis{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jp-title small{color:var(--jp-muted);font-weight:400;font-size:11.5px}
#jp-panel .jp-icon{width:28px;height:28px;border-radius:8px;color:var(--jp-muted)}
#jp-panel .jp-icon:hover{background:rgba(255,255,255,.08);color:#fff}

.jp-tabs,.jp-seg{display:flex;gap:3px;padding:3px;border-radius:10px;background:rgba(0,0,0,.32)}
.jp-tabs{margin:0 12px}
#jp-panel .jp-tabs button,#jp-panel .jp-seg button{flex:1;padding:6px 4px;border-radius:7px;color:var(--jp-muted);font-weight:550;transition:background .15s,color .15s}
#jp-panel .jp-tabs button:hover,#jp-panel .jp-seg button:hover{color:#fff}
#jp-panel .jp-tabs button.on{background:rgba(255,255,255,.12);color:#fff}
#jp-panel .jp-seg button.on{background:var(--jp-accent);color:#fff}

.jp-body{display:flex;flex-direction:column;gap:12px;padding:12px 14px 14px;overflow:auto;scrollbar-width:thin}
.jp-row{display:flex;gap:6px;align-items:center}
.jp-grow{flex:1;min-width:0}
.jp-field{display:flex;flex-direction:column;gap:6px}
.jp-label{font-size:10.5px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--jp-muted)}
.jp-label b{color:#fff;letter-spacing:0;margin-left:4px}
.jp-muted{color:var(--jp-muted);font-size:12px}
.jp-err{color:#ff8a8a;font-size:12px}
.jp-card{padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid var(--jp-line)}

#jp-panel input[type=text],#jp-panel input[type=password],#jp-panel input[type=number]{flex:1;min-width:0;padding:7px 10px;
  border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.35);color:#fff;font:inherit;outline:none}
#jp-panel input:focus{border-color:var(--jp-accent)}
#jp-panel input[type=number]{flex:0 0 62px}
#jp-panel input[type=range],#jp-panel input[type=checkbox]{accent-color:var(--jp-accent);margin:0}
#jp-panel input[type=range]{width:100%}

#jp-panel .jp-btn{padding:7px 11px;border-radius:8px;background:rgba(255,255,255,.08);white-space:nowrap;transition:background .15s,filter .15s}
#jp-panel .jp-btn:hover{background:rgba(255,255,255,.15)}
#jp-panel .jp-btn.primary{background:var(--jp-accent);color:#fff;font-weight:600}
#jp-panel .jp-btn.primary:hover{filter:brightness(1.12)}
#jp-panel .jp-btn:disabled{opacity:.4;cursor:default;filter:none}
#jp-panel .jp-link{color:#ff97aa;padding:0;text-decoration:underline}
.jp-grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}

.jp-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.jp-list li{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer}
.jp-list li:hover{background:rgba(255,255,255,.07)}
.jp-list li.dim{opacity:.45;cursor:not-allowed}
.jp-pill{flex:none;font-size:10px;font-weight:700;padding:2px 6px;border-radius:5px;background:rgba(255,255,255,.12)}
.jp-pill.ass{background:#1e40af}.jp-pill.web{background:#166534}.jp-pill.bd{background:#5b21b6}.jp-pill.warn{background:#7f1d1d}

.jp-drop{display:flex;flex-direction:column;align-items:center;gap:2px;padding:14px;border-radius:10px;cursor:pointer;
  border:1.5px dashed rgba(255,255,255,.18);text-align:center;transition:border-color .15s,background .15s}
.jp-drop:hover{border-color:var(--jp-accent);background:rgba(255,77,109,.06)}
.jp-drop input{display:none}
.jp-spin{display:inline-block;width:11px;height:11px;margin-right:7px;vertical-align:-1px;border-radius:50%;
  border:2px solid rgba(255,255,255,.2);border-top-color:#fff;animation:jp-spin .7s linear infinite}
@keyframes jp-spin{to{transform:rotate(360deg)}}

.jp-offset{display:flex;align-items:baseline;gap:10px}
.jp-offset b{flex:none;font:700 26px/1 ui-monospace,Consolas,monospace;letter-spacing:-.02em}
.jp-now-line{font:600 14px/1.4 "Hiragino Sans","Yu Gothic UI","Noto Sans JP",sans-serif;margin-bottom:4px}
.jp-check{display:flex;gap:10px;align-items:flex-start;cursor:pointer}
.jp-check input{margin-top:3px!important}
.jp-check small{display:block;color:var(--jp-muted);font-size:11.5px}
.jp-keys{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;align-items:center;font-size:12px;color:var(--jp-muted)}

.jp-foot{display:flex;gap:10px;align-items:center;padding:8px 14px;border-top:1px solid var(--jp-line);font-size:11.5px;color:var(--jp-muted)}
.jp-foot .jp-ellipsis{flex:1;min-width:0}
.jp-foot b{color:#fff}

#jp-toast{position:absolute;top:14px;left:50%;max-width:80%;padding:8px 14px;border-radius:10px;
  background:rgba(14,15,21,.92);border:1px solid var(--jp-line);color:#fff;font-size:13px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;
  opacity:0;transform:translate(-50%,-6px);transition:opacity .2s,transform .2s}
#jp-toast.show{opacity:1;transform:translate(-50%,0)}

html.jp-hide-native video::cue{opacity:0!important}
html.jp-hide-native :is(${NATIVE_CAPTIONS}){opacity:0!important}

/* Hide the cursor over the bare video. Cursor zones get a zero-specificity default so their
   children don't inherit "none" while the player's own cursor rules still win. */
.jp-cursorless,.jp-cursorless :not(:is(${CURSOR_ZONES}),:is(${CURSOR_ZONES}) *){cursor:none!important}
:where(.jp-cursorless) :where(${CURSOR_ZONES}){cursor:default}
`;

  let ui = null;

  function buildUI() {
    const host = document.createElement("div");
    host.id = "jp-host";
    host.innerHTML = `
      <div class="jp-box jp-top"></div>
      <div class="jp-box jp-bottom"><span class="jp-ja" lang="ja"></span><span class="jp-native"></span></div>
      <button id="jp-fab" type="button" title="Jimaku Player (J)">字</button>
      <div id="jp-panel" role="dialog" aria-label="Jimaku Player"></div>
      <div id="jp-toast" role="status"></div>`;
    const $ = (s) => host.querySelector(s);
    ui = {
      host,
      top: $(".jp-top"),
      bottom: $(".jp-bottom"),
      ja: $(".jp-ja"),
      native: $(".jp-native"),
      fab: $("#jp-fab"),
      panel: $("#jp-panel"),
      toast: $("#jp-toast"),
    };

    // Keep clicks on our UI from reaching the player (play/pause, fullscreen on dblclick).
    // mousemove is deliberately left alone: rikaikun listens for it on window.
    for (const el of [ui.fab, ui.panel, ui.ja])
      for (const type of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"])
        el.addEventListener(type, (e) => e.stopPropagation());

    ui.fab.addEventListener("click", () => togglePanel());

    // Pause while the pointer is on the line so rikaikun lookups don't race the next line.
    // Uses real movement rather than mouseenter, so a line appearing under a resting cursor doesn't pause.
    ui.ja.addEventListener("mousemove", (e) => {
      const v = getVideo();
      if (!cfg.pauseOnHover || state.hoverPaused || !v || v.paused || !(e.movementX || e.movementY)) return;
      v.pause();
      state.hoverPaused = true;
    });
    ui.ja.addEventListener("mouseleave", () => {
      const v = getVideo();
      if (state.hoverPaused && v?.paused) v.play().catch(() => {});
      state.hoverPaused = false;
    });

    ui.panel.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (el && !el.matches(":disabled, .dim")) actions[el.dataset.act](el);
    });
    ui.panel.addEventListener("input", (e) => {
      const t = e.target;
      if (t.id === "jp-query") state.query = t.value;
      else if (t.id === "jp-ep") state.episode = t.value === "" ? "" : parseInt(t.value, 10);
      else if (t.id === "jp-scale") {
        setCfg("fontScale", +t.value);
        applyLayout();
        ui.panel.querySelector("#jp-scale-val").textContent = `${Math.round(cfg.fontScale * 100)}%`;
      }
    });
    ui.panel.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.toggle) {
        setCfg(t.dataset.toggle, t.checked);
        applyLayout();
        renderPanel();
      } else if (t.id === "jp-file" && t.files[0]) loadLocalFile(t.files[0]);
    });
    // Typing in the panel must not trigger the player's (or our own) hotkeys.
    for (const type of ["keydown", "keyup", "keypress"])
      ui.panel.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type !== "keydown") return;
        if (e.key === "Escape") togglePanel(false);
        else if (e.key === "Enter" && e.target.matches("#jp-query, #jp-ep")) doSearch();
        else if (e.key === "Enter" && e.target.id === "jp-key") actions.saveKey();
      });

    applyLayout();
  }

  function mount() {
    const v = getVideo();
    const container = v && findContainer(v);
    if (!container) return;
    if (!ui) buildUI();
    if (ui.host.parentNode === container) return;
    if (!document.getElementById("jp-styles")) {
      const style = document.createElement("style");
      style.id = "jp-styles";
      style.textContent = STYLES;
      (document.head || document.documentElement).appendChild(style);
    }
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.classList.add("jp-container");
    container.appendChild(ui.host);
    applyLayout();
    renderPanel();
    log("mounted on", container);
  }

  function applyLayout() {
    if (!ui) return;
    ui.host.style.setProperty("--jp-scale", cfg.fontScale);
    (cfg.position === "top" ? ui.top : ui.bottom).prepend(ui.ja);
    document.documentElement.classList.toggle("jp-hide-native", cfg.nativeMode !== "player");
    wakeCursor();
  }

  // Show the cursor on any movement; hide it again over the bare video after a few idle seconds.
  const CURSOR_IDLE_MS = 3000;
  let cursorTimer = 0;
  function wakeCursor() {
    const container = ui?.host.parentElement;
    if (!container) return;
    container.classList.remove("jp-cursorless");
    clearTimeout(cursorTimer);
    if (cfg.hideCursor) cursorTimer = setTimeout(() => container.classList.add("jp-cursorless"), CURSOR_IDLE_MS);
  }

  function setLine(el, text) {
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle("on", !!text);
  }

  function tick() {
    const v = ui?.host.isConnected && getVideo();
    if (!v) return;
    state.timeMs = v.currentTime * 1000;
    const active = state.enabled ? activeSubs(state.subs, state.timeMs + state.offset) : [];
    if (active.length) state.lastSub = active[active.length - 1];
    setLine(ui.ja, active.map((s) => s.text).join("\n"));
    setLine(ui.native, cfg.nativeMode === "below" ? readNativeSubs(v) : "");
    if (state.open && state.tab === "sync") updateSyncPreview();
    fixRikaiPopup();
  }

  function toast(msg) {
    if (!ui) return;
    ui.toast.textContent = msg;
    ui.toast.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => ui.toast.classList.remove("show"), 1800);
  }

  function togglePanel(open = !state.open) {
    state.open = open;
    renderPanel();
    if (open && state.tab === "load" && !state.autoSearched && cfg.apiKey && !state.subs.length && state.detected.title) {
      state.autoSearched = true;
      doSearch();
    }
  }

  /* ---------------------------- panel ------------------------------- */
  function status() {
    if (state.busy) return `<div class="jp-muted"><i class="jp-spin"></i>${esc(state.busy)}…</div>`;
    return state.error ? `<div class="jp-err">${esc(state.error)}</div>` : "";
  }

  function fileTags(name) {
    const tags = [];
    if (!isSubFile(name)) tags.push(`<span class="jp-pill">${esc(name.split(".").pop().toUpperCase())}</span>`);
    if (/\.(ass|ssa)$/i.test(name)) tags.push('<span class="jp-pill ass">ASS</span>');
    if (/web|crunchy|amazon|netflix/i.test(name)) tags.push('<span class="jp-pill web">WEB</span>');
    if (/\b(bd|bdrip|blu-?ray)\b/i.test(name)) tags.push('<span class="jp-pill bd">BD</span>');
    return tags.join("");
  }

  function loadTab() {
    const d = state.detected;
    const query = state.query ?? d.title ?? "";
    const ep = state.episode ?? d.episode ?? "";
    const search = cfg.apiKey
      ? `<div class="jp-row">
           <input id="jp-query" type="text" placeholder="Show title" value="${esc(query)}">
           <input id="jp-ep" type="number" min="0" placeholder="Ep" title="Episode (blank = all)" value="${esc(ep)}">
           <button class="jp-btn primary" data-act="search">Search</button>
         </div>`
      : `<div class="jp-card">Add your <b>jimaku.cc API key</b> to search subtitles.
           <button class="jp-link" data-act="tab" data-tab="settings">Open settings →</button></div>`;

    let results = "";
    if (state.entry) {
      const files = sortFiles(state.files, cfg.preferAss);
      results = `
        <div class="jp-row">
          <div class="jp-grow"><div class="jp-label">Show</div><div class="jp-ellipsis">${esc(state.entry.name)}</div></div>
          <button class="jp-btn" data-act="changeShow">Change</button>
        </div>
        ${
          files.length
            ? `<ul class="jp-list">${files
                .map(
                  (f) => `<li data-act="file" data-i="${state.files.indexOf(f)}" class="${isSubFile(f.name) ? "" : "dim"}" title="${esc(f.name)}">
                    <div class="jp-grow"><div class="jp-ellipsis">${esc(f.name)}</div>
                    <div class="jp-muted">${formatSize(f.size)} · ${formatDate(f.last_modified)}</div></div>${fileTags(f.name)}</li>`,
                )
                .join("")}</ul>`
            : state.busy
              ? ""
              : `<div class="jp-muted">No files for episode ${esc(ep || "?")}. <button class="jp-link" data-act="showAll">Show all episodes</button></div>`
        }`;
    } else if (state.entries.length) {
      results = `<ul class="jp-list">${state.entries
        .map(
          (e) => `<li data-act="entry" data-id="${e.id}">
            <div class="jp-grow"><div class="jp-ellipsis">${esc(e.name)}</div>
            ${e.english_name && e.english_name !== e.name ? `<div class="jp-muted jp-ellipsis">${esc(e.english_name)}</div>` : ""}</div>
            ${e.flags?.movie ? '<span class="jp-pill">Movie</span>' : ""}
            ${e.flags?.unverified ? '<span class="jp-pill warn">Unverified</span>' : ""}</li>`,
        )
        .join("")}</ul>`;
    }

    return `${search}${status()}${results}
      <label class="jp-drop"><input id="jp-file" type="file" accept=".srt,.ass,.ssa,.vtt">
        <b>Load a local file</b><span class="jp-muted">.srt · .ass · .vtt — or drop it onto the player</span></label>`;
  }

  function syncTab() {
    const dis = state.subs.length ? "" : "disabled";
    const help =
      state.offset === 0
        ? "Using the file's own timing"
        : `Lines appear ${Math.abs(state.offset / 1000).toFixed(2)}s ${state.offset > 0 ? "earlier" : "later"}`;
    const nudges = [
      [-1000, "−1s", "Earlier by 1s (Shift+Z)"],
      [-200, "−0.2s", "Earlier by 0.2s (Z)"],
      [200, "+0.2s", "Later by 0.2s (X)"],
      [1000, "+1s", "Later by 1s (Shift+X)"],
    ];
    return `
      <div class="jp-offset"><b>${fmtDelay()}</b><span class="jp-muted">${help}</span></div>
      <div class="jp-card" id="jp-now"></div>
      <button class="jp-btn primary" data-act="anchor" ${dis}>Snap current line to now <kbd>S</kbd></button>
      <div class="jp-grid4">${nudges.map(([ms, l, t]) => `<button class="jp-btn" data-act="nudge" data-ms="${ms}" title="${t}">${l}</button>`).join("")}</div>
      <div class="jp-row">
        <button class="jp-btn jp-grow" data-act="rewind" ${dis}>⟲ Replay line <kbd>B</kbd></button>
        <button class="jp-btn jp-grow" data-act="anchorFirst" ${dis}>First line → now</button>
        <button class="jp-btn" data-act="resetOffset">Reset</button>
      </div>
      <p class="jp-muted" style="margin:0">Press <kbd>S</kbd> the instant you hear a line start — the line on screen (or the next one) snaps to that moment. The delay is remembered per show.</p>`;
  }

  function updateSyncPreview() {
    const el = ui.panel.querySelector("#jp-now");
    if (!el) return;
    let html = '<span class="jp-muted">Load subtitles to sync them.</span>';
    if (state.subs.length) {
      const t = state.timeMs + state.offset;
      const cur = activeSubs(state.subs, t).pop();
      const next = state.subs.find((s) => s.start > t);
      html = `<div class="jp-now-line jp-ellipsis">${cur ? esc(firstLine(cur.text)) : '<span class="jp-muted">— no line on screen</span>'}</div>
        <div class="jp-muted jp-ellipsis">${next ? `Next in ${((next.start - t) / 1000).toFixed(1)}s · ${esc(firstLine(next.text))}` : "End of subtitles"}</div>`;
    }
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
  }

  const NATIVE_HELP = {
    below: "Turn CC on in the player and its subtitles appear under the Japanese line.",
    hidden: "The player's own subtitles are hidden.",
    player: "The player draws its subtitles itself (they may overlap).",
  };
  const KEY_HELP = [
    ["J", "Open / close this panel"],
    ["S", "Snap current line to now"],
    ["B", "Replay current line"],
    ["Z / X", "Lines 0.2s earlier / later (Shift: 1s)"],
    ["H", "Hide / show Japanese line"],
    ["I", "Japanese line top / bottom"],
  ];

  function settingsTab() {
    const seg = (key, opts) =>
      `<div class="jp-seg">${opts
        .map(([v, l]) => `<button data-act="set" data-key="${key}" data-val="${v}" class="${cfg[key] === v ? "on" : ""}">${l}</button>`)
        .join("")}</div>`;
    const check = (key, label, hint = "") =>
      `<label class="jp-check"><input type="checkbox" data-toggle="${key}" ${cfg[key] ? "checked" : ""}>
         <span>${label}${hint && `<small>${hint}</small>`}</span></label>`;
    return `
      <div class="jp-field"><span class="jp-label">jimaku.cc API key</span>
        <div class="jp-row">
          <input id="jp-key" type="password" autocomplete="off" placeholder="Paste your API key" value="${esc(cfg.apiKey)}">
          <button class="jp-btn primary" data-act="saveKey">Save</button>
        </div>
        <span class="jp-muted">Free at <a href="https://jimaku.cc/profile" target="_blank" rel="noopener noreferrer">jimaku.cc/profile</a>. Stored by your userscript manager only.</span>
      </div>
      <div class="jp-field"><span class="jp-label">Player's own subtitles</span>
        ${seg("nativeMode", [["below", "Show below"], ["hidden", "Hide"], ["player", "Leave alone"]])}
        <span class="jp-muted">${NATIVE_HELP[cfg.nativeMode] || ""}</span>
      </div>
      <div class="jp-field"><span class="jp-label">Japanese line</span>${seg("position", [["bottom", "Bottom"], ["top", "Top"]])}</div>
      <div class="jp-field"><span class="jp-label">Text size <b id="jp-scale-val">${Math.round(cfg.fontScale * 100)}%</b></span>
        <input id="jp-scale" type="range" min="0.6" max="2.5" step="0.05" value="${cfg.fontScale}"></div>
      ${check("pauseOnHover", "Pause while hovering a line", "Gives rikaikun time to look words up; resumes when you move away.")}
      ${check("hideCursor", "Hide idle cursor over the video", "After 3s without moving. It never hides over subtitles, this panel or the player's controls.")}
      ${check("preferAss", "Prefer .ass files")}
      <div class="jp-field"><span class="jp-label">Hotkeys</span>
        <div class="jp-keys">${KEY_HELP.map(([k, d]) => `<span>${k.split(" / ").map((x) => `<kbd>${x}</kbd>`).join(" ")}</span><span>${d}</span>`).join("")}</div>
      </div>`;
  }

  const TABS = { load: ["Subtitles", loadTab], sync: ["Sync", syncTab], settings: ["Settings", settingsTab] };

  function renderPanel() {
    if (!ui) return;
    ui.fab.classList.toggle("active", state.open);
    ui.fab.classList.toggle("loaded", state.subs.length > 0);
    ui.panel.classList.toggle("open", state.open);
    if (!state.open) return;

    const focusId = ui.panel.contains(document.activeElement) ? document.activeElement.id : "";
    const d = state.detected;
    const subtitle = d.title ? esc(d.title) + (d.episode != null ? ` · Episode ${d.episode}` : "") : "No show detected";
    ui.panel.innerHTML = `
      <div class="jp-head">
        <div class="jp-logo">字</div>
        <div class="jp-title">Jimaku Player<small>${subtitle}</small></div>
        <button class="jp-icon" data-act="close" title="Close (Esc)">✕</button>
      </div>
      <div class="jp-tabs">${Object.entries(TABS)
        .map(([id, [label]]) => `<button data-act="tab" data-tab="${id}" class="${state.tab === id ? "on" : ""}">${label}</button>`)
        .join("")}</div>
      <div class="jp-body">${TABS[state.tab][1]()}</div>
      <div class="jp-foot">${
        state.subs.length
          ? `<span class="jp-ellipsis" title="${esc(state.file)}"><b>${state.subs.length}</b> lines · ${esc(state.file)}</span>
             <span>${fmtDelay()}</span><button class="jp-link" data-act="unload">Unload</button>`
          : '<span class="jp-ellipsis">No subtitles loaded</span>'
      }</div>`;
    if (focusId) ui.panel.querySelector("#" + focusId)?.focus();
    if (state.tab === "sync") updateSyncPreview();
  }

  /* --------------------------- actions ------------------------------ */
  async function run(label, fn) {
    state.busy = label;
    state.error = "";
    renderPanel();
    try {
      await fn();
    } catch (e) {
      state.error = e.message || String(e);
    }
    state.busy = "";
    renderPanel();
  }

  function doSearch() {
    const query = (state.query ?? state.detected.title ?? "").trim();
    if (!query) {
      state.error = "Type a show title to search.";
      return renderPanel();
    }
    state.entries = [];
    state.entry = null;
    state.files = [];
    return run("Searching jimaku.cc", async () => {
      state.entries = (await api(`/entries/search?anime=true&query=${encodeURIComponent(query)}`)) || [];
      if (!state.entries.length) throw new Error(`No matches for "${query}".`);
      const q = query.toLowerCase();
      const auto =
        state.entries.find((e) => e.id === cfg.entryCache[state.detected.slug]) ||
        state.entries.find((e) => !e.flags?.unverified && [e.name, e.english_name].some((n) => n?.toLowerCase() === q)) ||
        (state.entries.length === 1 ? state.entries[0] : null);
      if (auto) await pickEntry(auto.id);
    });
  }

  function pickEntry(id) {
    state.entry = state.entries.find((e) => e.id === id);
    if (!state.entry) return;
    if (state.detected.slug) {
      cfg.entryCache[state.detected.slug] = id;
      setCfg("entryCache", cfg.entryCache);
    }
    const ep = state.episode ?? state.detected.episode;
    return loadFiles(Number.isInteger(ep) ? ep : undefined);
  }

  const loadFiles = (episode) =>
    run("Loading files", async () => {
      state.files = await api(`/entries/${state.entry.id}/files${episode != null ? `?episode=${episode}` : ""}`);
    });

  function downloadFile(f) {
    if (!f) return;
    return run(`Downloading ${f.name}`, async () => applySubs(parseSubs(await request(f.url, false), f.name), f.name));
  }

  // Local files are usually UTF-8, but older Japanese .srt files are often Shift-JIS.
  async function decodeFile(file) {
    const buf = await file.arrayBuffer();
    const utf8 = new TextDecoder().decode(buf);
    return utf8.includes("�") ? new TextDecoder("shift_jis").decode(buf) : utf8;
  }
  const loadLocalFile = (file) =>
    run(`Reading ${file.name}`, async () => applySubs(parseSubs(await decodeFile(file), file.name), file.name));

  function applySubs(subs, name) {
    if (name && !subs.length) throw new Error(`No subtitle lines found in ${name}.`);
    state.subs = subs;
    state.file = name;
    state.lastSub = null;
    if (name) {
      toast(`Loaded ${subs.length} lines`);
      state.open = false;
    }
    renderPanel();
  }

  function setOffset(ms) {
    state.offset = Math.round(ms);
    if (state.detected.slug) {
      cfg.alignByShow[state.detected.slug] = state.offset;
      setCfg("alignByShow", cfg.alignByShow);
    }
    renderPanel();
  }

  // delayMs > 0 shows lines later.
  function nudge(delayMs) {
    setOffset(state.offset - delayMs);
    toast(`Subtitle delay ${fmtDelay()}`);
  }

  function anchorTo(sub, label) {
    setOffset(sub.start - state.timeMs);
    toast(`✓ ${label}: “${firstLine(sub.text).slice(0, 40)}”`);
    ui.fab.classList.remove("pulse");
    void ui.fab.offsetWidth;
    ui.fab.classList.add("pulse");
  }

  function anchorCurrent() {
    if (!state.subs.length) return toast("No subtitles loaded");
    const t = state.timeMs + state.offset;
    const sub = activeSubs(state.subs, t).pop() || state.subs.find((s) => s.start > t) || state.subs[state.subs.length - 1];
    anchorTo(sub, "Snapped");
  }

  function rewind() {
    if (state.lastSub) seekTo(state.lastSub.start - state.offset);
  }

  const actions = {
    close: () => togglePanel(false),
    tab: (el) => {
      state.tab = el.dataset.tab;
      state.error = "";
      renderPanel();
    },
    set: (el) => {
      setCfg(el.dataset.key, el.dataset.val);
      applyLayout();
      renderPanel();
    },
    saveKey: () => {
      setCfg("apiKey", ui.panel.querySelector("#jp-key").value.trim());
      toast(cfg.apiKey ? "API key saved" : "API key cleared");
      renderPanel();
    },
    search: doSearch,
    entry: (el) => pickEntry(+el.dataset.id),
    file: (el) => downloadFile(state.files[+el.dataset.i]),
    changeShow: () => {
      state.entry = null;
      state.files = [];
      delete cfg.entryCache[state.detected.slug];
      setCfg("entryCache", cfg.entryCache);
      renderPanel();
    },
    showAll: () => loadFiles(),
    anchor: anchorCurrent,
    anchorFirst: () => state.subs.length && anchorTo(state.subs[0], "First line"),
    rewind,
    nudge: (el) => nudge(+el.dataset.ms),
    resetOffset: () => setOffset(0),
    unload: () => {
      applySubs([], "");
      toast("Subtitles unloaded");
    },
  };

  /* ---------------------------- wiring ------------------------------ */
  const HOTKEYS = {
    j: () => togglePanel(),
    s: anchorCurrent,
    b: rewind,
    h: () => {
      state.enabled = !state.enabled;
      toast(state.enabled ? "Japanese subtitles on" : "Japanese subtitles off");
    },
    i: () => {
      setCfg("position", cfg.position === "top" ? "bottom" : "top");
      applyLayout();
      renderPanel();
    },
    z: (e) => nudge(e.shiftKey ? -1000 : -200),
    x: (e) => nudge(e.shiftKey ? 1000 : 200),
  };

  document.addEventListener("keydown", (e) => {
    if (!ui?.host.isConnected || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const k = e.key.toLowerCase();
    if (rikaiVisible() && "bjz".includes(k)) return; // rikaikun uses these while its popup is open
    HOTKEYS[k]?.(e);
  });

  // Capture phase, so the player can't swallow the events before we see them.
  for (const type of ["mousemove", "mousedown", "wheel"]) document.addEventListener(type, wakeCursor, { capture: true, passive: true });

  // Drop a subtitle file anywhere on the player.
  document.addEventListener("dragover", (e) => {
    if (ui?.host.isConnected && e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!ui?.host.isConnected || !file) return;
    e.preventDefault();
    if (isSubFile(file.name)) loadLocalFile(file);
    else toast("Drop a .srt, .ass or .vtt file");
  });

  setInterval(() => {
    mount();
    refreshDetection();
  }, 1000);
  setInterval(tick, 50);
  log("boot", location.hostname);
})();
