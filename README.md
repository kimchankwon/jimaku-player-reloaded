# Jimaku Player Reloaded

Tampermonkey userscripts that browse, download and time-align Japanese subtitles from
[jimaku.cc](https://jimaku.cc) directly inside the Crunchyroll and Anikoto players.

Based on [Jimaku Player](https://github.com/sheodox/jimaku-player) by sheodox.

## Install

| Site | Install link |
| --- | --- |
| Anikoto | [jimaku-anikoto.user.js](https://raw.githubusercontent.com/kimchankwon/jimaku-player-reloaded/main/jimaku-anikoto.user.js) |
| Crunchyroll | [jimaku-player-reloaded.user.js](https://raw.githubusercontent.com/kimchankwon/jimaku-player-reloaded/main/jimaku-player-reloaded.user.js) |

1. Install the **Tampermonkey** extension
   ([Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo),
   [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd),
   [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)).
2. **Chrome / Edge only:** let Tampermonkey run userscripts. Open `chrome://extensions`
   (`edge://extensions`), click **Details** on Tampermonkey and turn on **Allow User Scripts**.
   On browsers older than Chrome 138 there is no such toggle — turn on **Developer mode**
   (top-right of the extensions page) instead. Without this, scripts install but never run.
3. Click the install link for your site above. Tampermonkey opens an install page — click
   **Install** (or **Update** / **Reinstall** if you already have it).
4. Get an API key at [jimaku.cc/account](https://jimaku.cc/account).
5. Open an episode, press **J** (or hover the player and click the 字 button), go to
   **Settings**, paste the key and **Save**.

If Tampermonkey asks whether the script may connect to `jimaku.cc`, choose **Always allow** —
that's how it searches and downloads subtitles.

## Auto-update

Both scripts carry `@updateURL` / `@downloadURL` pointing at this repo, so Tampermonkey keeps
them current on its own:

- It checks **once a day** by default. To change that: Tampermonkey **Dashboard → Settings**,
  set *Config mode* to **Advanced**, then *Script Update → Check Interval*.
- To update right now: click the Tampermonkey toolbar icon → **Check for userscript updates**.
- Make sure updates aren't switched off for the script: **Dashboard →** click the script →
  **Settings** tab → *Check for updates* is ticked.

**Installed it before by pasting or importing the file?** That copy may not know where to
update from. Click the install link above once; Tampermonkey replaces the old copy (same name
and namespace) and your saved API key and settings carry over.

**Publishing an update:** Tampermonkey only installs an update when the `@version` in the
header goes up, so bump it in every change to a `.user.js` file. GitHub's raw files can take
a few minutes to refresh after a push.

## Use

- **Browse** — the show and episode are detected from the page; hit Search, pick a file.
- **File** — load a local `.srt` / `.ass` / `.ssa` / `.vtt` instead.
- **Sync** — press **S** the moment you hear a line start and the current subtitle snaps to
  that timestamp. The offset is remembered per show.
- Click a subtitle line to open it in Google Translate. Text is selectable.

### Hotkeys

| Key | Action |
| --- | --- |
| `J` | open/close the panel |
| `S` | anchor the current subtitle to now |
| `B` | rewind to the last shown subtitle |
| `H` | toggle subtitles on/off |
| `I` | flip position top/bottom |
| `Z` / `X` | nudge −0.2s / +0.2s (with `Shift`: ±1s) |

## What was fixed in 2.7.1

- **`IS_MAIN` never matched.** The hostname check had been mangled into a markdown link
  (`"[www.crunchyroll.com](https://…)"`), so the entire main-frame half of the script —
  panel, overlay, everything — was dead. This was the reason nothing appeared.
- **VTT parsing dropped every cue after a `NOTE`.** `([^\n]*\n)*` matched greedily to the
  end of the file; a `NOTE` block now ends at the next blank line.
- **The 字 button was invisible.** `#jp-host:hover` can never match — the host has
  `pointer-events: none`. Hover is now tracked on the player container.
- **Overlapping cues were missed.** Binary search over `[start, end]` fails when an ASS sign
  spans several dialogue lines; it now finds the last started cue and walks back.
- **Native subtitles kept showing.** The real player is a cross-origin iframe, so the parent
  frame's CSS could not reach it. The iframe half now hides them itself on request, and the
  setting finally has a checkbox (it was stored but unreachable).
- **Hotkeys did nothing while the player had focus.** The iframe forwards them to the parent.
- **Crashes at `document-start`** when `document.head` / `document.body` did not exist yet.
- **`@match`** collapsed to `https://*.crunchyroll.com/*`, covering regional domains.
- Panel keystrokes no longer leak to Crunchyroll's own shortcuts; remounting is throttled
  instead of running on every DOM mutation; parse failures and bad API keys now report
  instead of silently loading zero lines.

## Tests

`node --check` plus a small harness that exercises the parsers and the cue lookup:

```bash
node scripts/test.js
```

## Anikoto version (`jimaku-anikoto.user.js`, 3.0.1-anikoto)

Same idea for Anikoto's JW Player / Plyr embeds. Differences from the Crunchyroll script:

- **rikaikun works on the Japanese line.** It's plain DOM text above the player's click layers.
  Its `mousemove` events reach `window`, and rikaikun's popup is moved into the player while
  it's fullscreen so you can still see it. *Pause while hovering a line* (on by default)
  stops the next line from replacing the one you're reading.
- **The player's own subtitles show below the Japanese line.** Settings → *Player's own
  subtitles*: **Show below** (turn CC on in the player), **Hide**, or **Leave alone**.
- One **Subtitles** tab for jimaku search and local files. Drop a `.srt`/`.ass`/`.vtt` onto the
  player to load it. Shift-JIS files are detected.
- Settings live in Tampermonkey storage, which anikoto and every player iframe share. The
  top page sends the detected show/episode to the player iframe.
- The cursor hides after 3 seconds without moving over the bare video. It never hides over the
  Japanese line, the panel or the player's controls (Settings → *Hide idle cursor over the video*).
- `Z` moves lines earlier and `X` moves them later. The Sync tab shows this as a delay.

```bash
node scripts/test-anikoto.js
```

## Changelog

- **Anikoto 3.0.1-anikoto / Crunchyroll 2.7.2** — `@updateURL` / `@downloadURL` added so Tampermonkey
  auto-updates from this repo; install and update instructions in this README; API key
  links point at jimaku.cc/account.
- **Anikoto 3.0.0-anikoto** — first Anikoto release (see the section above).
- **Crunchyroll 2.7.1** — see *What was fixed in 2.7.1*.
