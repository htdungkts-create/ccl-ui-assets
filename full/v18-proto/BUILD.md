# CCL FULL MODE · chat-native static UI bundle

- Source: CCL Behavior Prototype index.html, artifact GctYT47z7zEuuhowF9nHuB version 1793087786-96fc, sha256 04255976c784957d73f7d0f35184c62876ca297781de6416acb13fd2a064e9ef (structurally ⊇ CH6T277z6tcwNMgzLepAoN, see P015).
- Process: `python3 build_full.py index.html .` (deterministic; only the listed exact substitutions).
- Content: presentation CSS/JS + generic behavior machinery + UI image assets. No project data, no CCL_STATE, no law text, no credentials. LIVE/NORMAL connector blocks removed.
- Runtime data is injected per chat turn via `window.CCL_DATA`; transport via `window.CCL_BRIDGE` (sendPrompt in the same chat).
- Native delta: compact rail `.cb` in-flow (chat widget forbids position:fixed).
- Authority: CHO PHÉP PUBLIC UI BUNDLE (P018). Pin by commit hash only.

## P020 correction
- Asset base: bundle no longer depends on the loader running first; base = window.CCL_BASE or the bundle's own script URL (document.currentScript).
- Loader must inject the bundle script dynamically AFTER setting CCL_BASE/CCL_DATA/CCL_BRIDGE (widget runs external scripts before inline ones).
- Host isolation: `:where(#cs) button{all:revert}` so chat host button styles do not override canonical class rules.

## P028 split-frame adapter (candidate, not cutover)
- New files `ccl-split.css` + `ccl-split.js`: LIVE-only wrapper (active only when `window.CCL_DATA.live`). Moves existing v18 nodes into a bounded frame: left 9-function rail outside the scroll owner, right pane `overflow-y:auto`. `ccl-full.js/css` unchanged (same sha as b27085b).
- Gesture (P027d, device-tested): touch horizontal drag in pane -> pane scrollTop (gain 2.2, threshold 7px, no pointer capture, click swallowed only after a drag). Vertical drag on pane does nothing by design; rail/outside scroll the chat.
- Navigation is local (goTo on pane). No sendPrompt for navigation. `Element.prototype.scrollIntoView` is scoped so elements inside the pane scroll the pane, not the outer chat.
- LIVE clean: compact rail, main 5+4 rail, mock tags, state-machine log hidden; Quyết Định hidden unless `CCL_DATA.qd_live`.
- Native deltas: hero height 372px (bounded frame); narrow-pane `.bc-rec em` wraps; sidebar order = Soái Lệnh first (Huynh's P026 reference image).
- Optional data: `CCL_DATA.sections` [{sem,title,paras[]}] and `frame_h`; text rendered via escaping.

## P030 mobile presentation correction (ccl-split.css/js only)
- Sidebar: width clamp(78px,22vw,92px), icon 30px, label 12px (1 line at 340–412), active = gold left bar + tint (status dot removed in sidebar), off items opacity .5. Frame height default 560, loader may set 600.
- Pane: gutters 16px (--gx/--gxl/--gxr overridden on .sf-pane), body 15.5px/1.5, section headings 20–22px, hero title clamp(22px,6.4vw,26px) wraps, lead 15px.
- Soái Lệnh card: 1 column (portrait 56px top row, text full width), options full-width buttons 15.5px, recommend badge in normal flow (no overlay), CTA full width.
- Cleanup: `#bpReset` and its wrapper, `#smStore` hidden in LIVE. Raw IDs/timestamps are not rendered by the bundle; front-stage copy comes from CCL_DATA (loader).
- Unchanged: ccl-full.*, engine/state machine, bridge, gesture (gain 2.2/threshold 7px), routing (local goTo).

## P031 mobile top rail (ccl-split.css only; JS unchanged since P030)
- `@media(max-width:600px)`: frame becomes a column. Rail = 5+4 grid at the top of the frame (10-col grid, row 2 starts at col 2), outside the scroll owner (not fixed/sticky), height ~107px, icon 28px, label 11.5px, active = gold underline. Pane = full width below (flex:1; min-height:0; overflow-y:auto).
- Typography (mobile only): sans body 15px/1.55 weight 400, section headings 17–20px (sans 500 for .sh and card question; serif kept for hero title and .sec-h/.cta), hero title clamp(26px,7.4vw,30px), meta 11–13px, small-caps labels 11px/.08em. Chip moved into hero flow (no overlay), --hh 280px, --ov 40px.
- Desktop/tablet (>600px): unchanged sidebar candidate. Gesture, routing, engine: unchanged.

## P033 top rail refined (ccl-split.css rewritten; ccl-split.js only adds the ccl-live guard class)
- Layout: top rail for all widths (no sidebar). <=719px: 5+4 grid, rail ~105px, items 48px, icon ~27px, label 11px/500. >=720px: 9 in one row (items 52px, label 12px). Rail sits outside the scroll pane. Active = burgundy tint + 2px gold underline; no dot.
- Fonts: UI "Noto Sans","Roboto",system-ui; display "Noto Serif",Georgia (hero title, .sec-h, entry CTA). Body 15px/1.55 w400; section heading 18px w500; hero title clamp(26px,7.2vw,30px) (<=719) / up to 38px (>=720); kicker/meta 10.5–12px, tracking .04–.08em; button 14.5–15px w500; badges 11px.
- Hero: height auto (min 210px), chip in flow; --ov 28px. Soái Lệnh portrait 56px, single column card.
- LIVE guard: `.cs.ccl-live` (class set by loader/adapter) hides canonical compact rail, 5+4 rail, mock tags, state log, reset button and the Quyết Định card even if the adapter fails to mount.
