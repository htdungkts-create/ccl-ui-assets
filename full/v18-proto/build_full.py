#!/usr/bin/env python3
"""CCL FULL MODE bundle builder (deterministic).
Input : CCL Behavior Prototype index.html (artifact GctYT47z7zEuuhowF9nHuB @1793087786-96fc, sha256 0425…e9ef)
Output: ccl-full.css, ccl-full.js. Only listed exact text substitutions; everything else byte-identical."""
import re,sys,hashlib
src=sys.argv[1]; out=sys.argv[2]
s=open(src,encoding='utf-8').read()
assert hashlib.sha256(s.encode()).hexdigest()=='04255976c784957d73f7d0f35184c62876ca297781de6416acb13fd2a064e9ef'
def once(t,a,b):
    assert t.count(a)==1,(a[:80],t.count(a)); return t.replace(a,b)
styles=re.findall(r'<style>(.*?)</style>',s,flags=re.S)
scripts=re.findall(r'<script>(.*?)</script>',s,flags=re.S)
assert len(styles)==2 and len(scripts)==3
css=styles[1]   # styles[0] = artifact publish skeleton reset, not page source
css+="\n/* HOST ISOLATION (P020): chat host pre-styles <button>; revert host element rules inside #cs (specificity 0,0,1 · loaded after host) so canonical class rules apply as in v18. */\n:where(#cs) button,:where(#cs) button:hover,:where(#cs) button:active,:where(#cs) button:focus{all:revert}\n"
css+="\n/* NATIVE DELTA (P016 §4): chat widget cấm position:fixed và không có cuộn nội bộ → compact rail in-flow đầu khung, không sticky. */\n.cb{position:relative;transform:none;opacity:1;pointer-events:auto}\n"
js=scripts[1]
# 1. FULL MODE canonical (= ?proto=1)
js=once(js,'const DEV=["proto","test","state","log","dbg","ba"].some(k=>_q.has(k));','const DEV=true;   /* CHAT-NATIVE FULL MODE (P016 §1) */')
# 2. asset base (CDN commit-pinned base injected by loader)
js='var CCL_A=(window.CCL_BASE||(function(){var c=document.currentScript;return c&&c.src?c.src.replace(/[^/]*$/,""):"";})())+"assets/";\n'+js
js=once(js,'const BA_DIR="assets/behavior/";','const BA_DIR=CCL_A+"behavior/";')
js=once(js,'const MINI_DIR="assets/mini/";','const MINI_DIR=CCL_A+"mini/";')
js=once(js,'<img src="assets/icon-${f}.webp"','<img src="${CCL_A}icon-${f}.webp"')
js=once(js,'data-fb="assets/icon','data-fb="${CCL_A}icon')
assert 'assets/' not in re.sub(r'CCL_A\+"|\$\{CCL_A\}|/\*.*?\*/|"assets/";','',js,flags=re.S).replace('(window.CCL_BASE||"")+"assets/"',''),'stray assets/'
# 3. remove NORMAL/LIVE connector blocks (dead when DEV=true; contain business IDs)
a=js.index('if(!DEV)document.documentElement.dataset.entry="NONE";')
b=js.index('if(PROTO&&!ENTRY_MOCK)document.documentElement.dataset.entry="wait";')
removed=js[a:b]; assert removed.count('if(!DEV)')==3
js=js[:a]+'/* LIVE/NORMAL connector blocks removed from public bundle (dead in FULL MODE; contained business IDs). Data arrives via window.CCL_DATA. */\n'+js[b:]
# 4. data adapter: work texts
js=once(js,'const PROTO_WORK=`','const _W=(window.CCL_DATA&&window.CCL_DATA.work)||{};\nconst PROTO_WORK=`')
js=once(js,'${HY("[MOCK] Rà xong thì trình ta điểm nối và điểm quyết.")}','${HY(_W.hy?esc(_W.hy):"[MOCK] Rà xong thì trình ta điểm nối và điểm quyết.")}')
js=once(js,'${P("[MOCK] Lượng đã rà xong. Có một lệnh cần Huynh truyền và một điểm cần Huynh phê. Hai thẻ dưới đây là PROTOTYPE hành vi để thử, chưa nối runtime.")}','${P(_W.lu?esc(_W.lu):"[MOCK] Lượng đã rà xong. Có một lệnh cần Huynh truyền và một điểm cần Huynh phê. Hai thẻ dưới đây là PROTOTYPE hành vi để thử, chưa nối runtime.")}')
js=once(js,'P("[MOCK] Lệnh tiếp theo cho mạch rà soát:")','P(_W.sl?esc(_W.sl):"[MOCK] Lệnh tiếp theo cho mạch rà soát:")')
js=once(js,'${P("[MOCK] Điểm thuộc authority của Huynh:")}','${P(_W.qd?esc(_W.qd):"[MOCK] Điểm thuộc authority của Huynh:")}')
# 5. data adapter: work id + flow data + live flag
js=once(js,'const WORK_ID="W-TCTL-PROTO-002";','const WORK_ID=(window.CCL_DATA&&window.CCL_DATA.work_id)||"W-TCTL-PROTO-002";')
js=once(js,'  const LBL={1:"Chờ chọn"','  (function(D){if(D)for(const k in D)FLOW[k]=Object.assign({},FLOW[k],D[k]);})(window.CCL_DATA&&window.CCL_DATA.flow);\n  const _LIVE=!!(window.CCL_DATA&&window.CCL_DATA.live);\n  const LBL={1:"Chờ chọn"')
# 6. live: mock runtime/verifier test panels off (kết quả thật về qua lượt chat kế)
js=once(js,'if(c.state===3&&!c.flag)t=`Bảng thử','if(c.state===3&&!c.flag&&!_LIVE)t=`Bảng thử')
js=once(js,'if(c.state===4&&!c.flag&&!c.verified)t=`Bảng thử','if(c.state===4&&!c.flag&&!c.verified&&!_LIVE)t=`Bảng thử')
# 7. transport bridge: COMMIT thành công → CCL_BRIDGE (loader → sendPrompt same chat)
js=once(js,'    const r=await sendAs(ev.actor,ev);\n','    const r=await sendAs(ev.actor,ev);\n    if(r&&r.ok&&!r.duplicate&&ev.type==="COMMIT"&&window.CCL_BRIDGE){const c0=get(ev.card);try{if(c0)window.CCL_BRIDGE.commit(c0.flow,c0.sel,FLOW[c0.flow]);}catch(e){}}\n')
js=scripts[0]+'\n'+js+'\n'+scripts[2]
open(out+'/ccl-full.css','w',encoding='utf-8').write(css)
open(out+'/ccl-full.js','w',encoding='utf-8').write(js)
print('css',len(css.encode()),'js',len(js.encode()),'removed',len(removed))
