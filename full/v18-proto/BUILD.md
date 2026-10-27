# CCL FULL MODE · chat-native static UI bundle

- Source: CCL Behavior Prototype index.html, artifact GctYT47z7zEuuhowF9nHuB version 1793087786-96fc, sha256 04255976c784957d73f7d0f35184c62876ca297781de6416acb13fd2a064e9ef (structurally ⊇ CH6T277z6tcwNMgzLepAoN, see P015).
- Process: `python3 build_full.py index.html .` (deterministic; only the listed exact substitutions).
- Content: presentation CSS/JS + generic behavior machinery + UI image assets. No project data, no CCL_STATE, no law text, no credentials. LIVE/NORMAL connector blocks removed.
- Runtime data is injected per chat turn via `window.CCL_DATA`; transport via `window.CCL_BRIDGE` (sendPrompt in the same chat).
- Native delta: compact rail `.cb` in-flow (chat widget forbids position:fixed).
- Authority: CHO PHÉP PUBLIC UI BUNDLE (P018). Pin by commit hash only.
