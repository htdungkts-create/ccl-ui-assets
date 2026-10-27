/* P045 — toggle mở/đóng rail 9 icon (5+4). Chỉ presentation; KHÔNG zoom/fullscreen/resize host. Không đụng engine/adapter P032.
   Mượn CCL_SPLIT.goTo; đồng bộ active qua MutationObserver. */
(function(){
  function init(){var S=window.CCL_SPLIT;if(!S||!S.ready)return false;
    var rail=S.rail,sf=rail.parentNode;if(rail.querySelector(".sf-tg"))return true;
    var ms=[].slice.call(rail.querySelectorAll(".m[data-sem]"));
    var tg=document.createElement("button");tg.type="button";tg.className="sf-tg";tg.setAttribute("aria-expanded","false");tg.setAttribute("aria-label","Mở rail đầy đủ 9 mục");
    tg.innerHTML='<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>';rail.appendChild(tg);
    var full=document.createElement("div");full.className="sf-full";full.setAttribute("aria-label","Chín mục");
    ms.forEach(function(m){var im=m.querySelector("img"),b=document.createElement("button");b.type="button";b.className="it";b.dataset.sem=m.dataset.sem;
      b.innerHTML='<img alt="" src="'+(im?im.dataset.fb||im.src:"")+'"><span class="lb">'+m.querySelector("span").textContent+"</span>";
      b.querySelector("img").onerror=function(){this.onerror=null;if(im)this.src=im.src;};full.appendChild(b);});
    sf.insertBefore(full,rail.nextSibling);
    function sync(){[].slice.call(full.children).forEach(function(b,i){var m=ms[i];b.classList.toggle("on",m.classList.contains("on"));b.classList.toggle("off",m.classList.contains("off"));});}
    function set(o){full.classList.toggle("open",o);tg.setAttribute("aria-expanded",o?"true":"false");tg.setAttribute("aria-label",o?"Thu gọn rail":"Mở rail đầy đủ 9 mục");}
    tg.addEventListener("click",function(){set(!full.classList.contains("open"));});
    full.addEventListener("click",function(e){var b=e.target.closest(".it");if(!b||b.classList.contains("off"))return;S.goTo(b.dataset.sem);set(false);});
    new MutationObserver(sync).observe(rail,{attributes:true,subtree:true,attributeFilter:["class"]});sync();
    window.CCL_SPLIT_TG={set:set,full:full,tg:tg};return true;}
  var t0=Date.now();(function w(){if(init())return;if(Date.now()-t0>9000)return;setTimeout(w,80);})();
})();
