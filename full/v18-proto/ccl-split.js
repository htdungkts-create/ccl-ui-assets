/* CCL SPLIT-FRAME adapter (P028 candidate). LIVE only. Moves existing v18 nodes into a bounded 2-zone frame:
   left = 9-function rail (outside the scroll owner), right = pane (overflow-y:auto). Touch: horizontal drag -> pane scrollTop (P027d gesture).
   No behavior-engine/state-machine change; navigation is local (no sendPrompt). */
(function(){
  var D=window.CCL_DATA;if(!D||!D.live)return;
  var ORDER=["SOAI_LENH","QUAN_BAO","THE_TRAN","DUNG_BINH","BINH_PHAP","BINH_LUC","BINH_KHI","HOI_BAO","CHIEN_BAO"];
  var META={SOAI_LENH:["soai-lenh","Soái Lệnh",1.05],QUAN_BAO:["quan-bao","Quân Báo",1],THE_TRAN:["the-tran","Thế Trận",1.16],DUNG_BINH:["dung-binh","Dụng Binh",1.02],BINH_PHAP:["binh-phap","Binh Pháp",1.04],BINH_LUC:["binh-luc","Binh Lực",1.08],BINH_KHI:["binh-khi","Binh Khí",1.08],HOI_BAO:["hoi-bao","Hồi Báo",.93],CHIEN_BAO:["chien-bao","Chiến Báo",1.1]};
  var A=(window.CCL_BASE||"")+"assets/";
  function el(t,c,h){var e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;}
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
  function build(){
    var cs=document.getElementById("cs");if(!cs||cs.classList.contains("sf-on"))return;
    var entry=cs.querySelector("#entry"),work=cs.querySelector("section.work");if(!entry||!work)return;
    /* real sections (read-only data from CCL_DATA.sections) go into the active response, before the Soái Lệnh section */
    var msg=work.querySelector(".turn.luong .msg"),slsec=msg&&msg.querySelector('.ssec[data-sem="SOAI_LENH"]');
    (D.sections||[]).forEach(function(s){if(!msg||!slsec||!META[s.sem])return;
      var sec=el("section","ssec","<h3 class=\"sh\">"+esc(s.title)+"</h3>"+(s.paras||[]).map(function(p){return"<p>"+esc(p)+"</p>";}).join(""));
      sec.id="s-p1-"+s.sem;sec.dataset.sem=s.sem;msg.insertBefore(sec,slsec);});
    /* Quyết Định: ẩn khi chưa có authority point thật */
    if(!D.qd_live){var h=[].slice.call(work.querySelectorAll("h3.sh")).filter(function(x){return/^Quyết Định/.test(x.textContent);})[0];
      if(h){var n=h.nextElementSibling;h.classList.add("sf-hide");while(n&&!(n.matches&&(n.matches("h3,span.mock-tag")))){n.classList.add("sf-hide");n=n.nextElementSibling;}}}
    var sf=el("div","sf"),rail=el("nav","sf-rail"),pane=el("div","sf-pane");
    rail.setAttribute("aria-label","Chín mục");pane.id="sfp";pane.tabIndex=-1;
    ORDER.forEach(function(id){var m=META[id],b=el("button","m",'<img class="mi" style="--ms:'+m[2]+'" src="'+A+"mini/mini-"+m[0]+'.webp" alt="" data-fb="'+A+"icon-"+m[0]+'.webp" onerror="this.onerror=null;this.src=this.dataset.fb"><span>'+m[1]+"</span>");
      b.type="button";b.dataset.sem=id;rail.appendChild(b);});
    sf.appendChild(rail);sf.appendChild(pane);
    /* #sf-h: chiều cao khung do loader quyết (mặc định 560px) */
    if(D.frame_h)sf.style.setProperty("--sf-h",D.frame_h+"px");
    var mt=[].slice.call(cs.querySelectorAll(".mock-tag"));
    cs.insertBefore(sf,cs.firstChild);pane.appendChild(entry);pane.appendChild(work);
    cs.classList.add("sf-on");
    var btns=[].slice.call(rail.querySelectorAll(".m")),anim=0,navTarget=null;
    function secOf(id){return work.querySelector('.ssec[data-sem="'+id+'"]')||(id==="SOAI_LENH"?entry.querySelector(".sheet .body"):null);}
    function setActive(id){btns.forEach(function(b){b.classList.toggle("on",b.dataset.sem===id);});}
    function refresh(){btns.forEach(function(b){var has=!!secOf(b.dataset.sem);b.classList.toggle("off",!has);if(has){b.removeAttribute("aria-disabled");b.removeAttribute("title");}else{b.setAttribute("aria-disabled","true");b.title="Response hiện hành không có mục này";}});
      var st=cs.querySelector('.cb .it.st,.cb-pop .it.st');btns.forEach(function(b){b.classList.toggle('st',!!st&&b.dataset.sem===st.dataset.sem);});}
    function posOf(t){return Math.max(0,Math.round(t.getBoundingClientRect().top-pane.getBoundingClientRect().top+pane.scrollTop-8));}
    var reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
    function goTo(id){var sec=secOf(id);if(!sec)return;setActive(id);navTarget=id;
      var y0=pane.scrollTop,y1=posOf(sec),D2=reduce?0:200,t0=performance.now();cancelAnimationFrame(anim);
      if(!D2){pane.scrollTop=y1;return;}
      (function step(t){var k=Math.min(1,(t-t0)/D2),e=1-Math.pow(1-k,3);pane.scrollTop=y0+(y1-y0)*e;if(k<1)anim=requestAnimationFrame(step);})(performance.now());}
    rail.addEventListener("click",function(e){var b=e.target.closest(".m[data-sem]");if(!b||b.classList.contains("off"))return;goTo(b.dataset.sem);});
    function spy(){if(navTarget)return;var line=pane.scrollTop+pane.clientHeight*.3,cur=null;
      ORDER.forEach(function(id){var s=secOf(id);if(s&&work.contains(s)&&posOf(s)<=pane.scrollTop+pane.clientHeight*.3)cur=id;});setActive(cur);}
    pane.addEventListener("scroll",function(){spy();},{passive:true});
    /* scrollIntoView trong pane chỉ cuộn pane, không kéo chat ngoài (v18 CTA dùng scrollIntoView) */
    var _sv=Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView=function(o){if(pane.contains(this)){var r=this.getBoundingClientRect(),p=pane.getBoundingClientRect();var y=pane.scrollTop+(r.top-p.top)-(pane.clientHeight-r.height)/2;pane.scrollTo({top:Math.max(0,y),behavior:(o&&o.behavior)||"auto"});}else return _sv.apply(this,arguments);};
    /* gesture: touch horizontal drag -> pane scrollTop (P027d). Không capture pointer; chỉ vào chế độ kéo sau ngưỡng; nuốt click sau khi kéo. */
    var g=null,GAIN=2.2,TH=7,dragged=false;
    pane.addEventListener("pointerdown",function(e){if(e.pointerType!=="touch")return;g={id:e.pointerId,x:e.clientX,y:e.clientY,tx:0,on:false};cancelAnimationFrame(anim);navTarget=null;});
    pane.addEventListener("pointermove",function(e){if(!g||e.pointerId!==g.id)return;var dx=e.clientX-g.x;g.x=e.clientX;g.tx+=dx;
      if(!g.on&&Math.abs(g.tx)>=TH){g.on=true;dragged=true;}
      if(g.on){pane.scrollTop-=dx*GAIN;}});
    function end(){g=null;if(dragged)setTimeout(function(){dragged=false;},350);}
    pane.addEventListener("pointerup",end);pane.addEventListener("pointercancel",end);
    pane.addEventListener("click",function(e){if(dragged){e.stopPropagation();e.preventDefault();}},true);
    refresh();spy();
    window.CCL_SPLIT={pane:pane,rail:rail,goTo:goTo,refresh:refresh,ready:true};
  }
  var t0=Date.now();(function wait(){if(window.BP&&window.BP.ready){build();return;}if(Date.now()-t0>8000)return;setTimeout(wait,60);})();
})();
