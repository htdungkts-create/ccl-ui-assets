/*CCL_SM:BEGIN*/
/* CCL BEHAVIOR STATE MACHINE · candidate v0.3 (persistence + recovery + identity/authority)
   - Provider-neutral: không DOM, không gọi mạng. Chạy được trong trình duyệt và Node.
   - Event-sourced: model = replay(log). Không có snapshot làm nguồn sự thật. Reducer thuần (ts do caller truyền vào).
   - Một nền state chung cho Soái Lệnh (sl) và Quyết Định (qd); authority khác nhau nằm ở POLICY.
   - Recommendation ≠ Selection ≠ Decision ≠ Execution ≠ Verification.
   - ACTOR ≠ ROLE ≠ AUTHORITY: actor_id là danh tính; role + authority_ref đi kèm event cần quyền riêng (VERIFY).
   - "Ai được làm" đọc từ ev.auth.role — vai trò do authority resolver phân giải LÚC APPEND và ghi vào event. Không đọc nhãn actor.
   - Danh tính (IdP) và nguồn authority trong candidate là MOCK (chưa có xác thực từ host). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CCL_SM = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCHEMA = 3;
  const GENESIS = "0000000000000";
  const ST = { S1: 1, S2: 2, S3: 3, S4: 4 };
  const STATE_NAME = { 1: "S1 · Chờ chọn", 2: "S2 · Đã chọn, còn đổi được", 3: "S3 · Đang thi hành, khóa lựa chọn", 4: "S4 · Hoàn tất" };

  /* ROLE CEILING — vai trò nào CÓ THỂ làm gì (trần). Actor cụ thể có làm được hay không do grant quyết ở resolver. */
  const POLICY = {
    sl: {
      kind: "command", propose: ["ADVISOR"], recommend: ["ADVISOR"], select: ["PRINCIPAL", "DELEGATE"], commit: ["PRINCIPAL", "DELEGATE"], commitProof: "gesture",
      runtime: ["RUNTIME"], control: ["PRINCIPAL"], verify: ["VERIFIER"],
      domain: { 1: "TODO", 2: "TODO", 3: "DOING", 4: "DONE" }
    },
    qd: {
      kind: "authority", propose: ["ADVISOR"], recommend: ["ADVISOR"], select: ["PRINCIPAL", "DELEGATE"], commit: ["PRINCIPAL"], commitProof: "gesture",
      authorityRecord: true, runtime: ["RUNTIME"], control: ["PRINCIPAL"], verify: ["VERIFIER"],
      domain: { 1: "PROPOSAL", 2: "PROPOSAL", 3: "AUTHORIZED · chờ ghi nhận", 4: "APPROVED / EFFECTIVE" }
    }
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const who = (a) => String(a || "").split(":")[0];
  const role = (ev) => (ev.auth && ev.auth.decision === "ALLOW" ? ev.auth.role : null);
  const allow = (ev, list) => list.indexOf(role(ev)) >= 0;
  const deny = (reason) => ({ ok: false, reason });
  const empty = () => ({ cards: {}, order: [], seqByFlow: { sl: 0, qd: 0 } });

  /* ---------- hash + JSON chuẩn hóa (phát hiện ghi hỏng / sửa tay) ---------- */
  function stable(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  }
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
  }
  const hashOf = (entry) => { const c = Object.assign({}, entry); delete c.hash; return cyrb53(stable(c)); };

  function newCard(model, id, flow, nOpts, replaces) {
    model.seqByFlow[flow] = (model.seqByFlow[flow] || 0) + 1;
    return {
      id, flow, n: model.seqByFlow[flow], nOpts,
      state: ST.S1, sel: null, rec: null,
      flag: null,                       // null | "blk" | "sup"
      verified: false, verification: null,
      replaces: replaces || null, pendingFork: null, supBy: null, supById: null,
      discarded: false,
      authority: null, order: null,     // bản ghi commit (qd: authority · sl: order) — bất biến khi còn hiệu lực
      voided: [],                       // authority/order bị thu hồi (status REVOKED)
      execution: null,                  // {executor, reported_by, attempt, at}
      attempt: 0, lastFail: null
    };
  }

  /* Reducer thuần: (model, event) -> {ok, model, reason, from, to} */
  function reduce(model0, ev) {
    const m = clone(model0);
    const t = ev.type, a = ev.actor, p = ev.payload || {};
    if (t === "CREATE") {
      if (!POLICY[p.flow] || !allow(ev, POLICY[p.flow].propose)) return deny("Chỉ vai trò ADVISOR (Lượng) tạo thẻ trình");
      if (!POLICY[p.flow]) return deny("Flow không hợp lệ");
      if (!p.id || m.cards[p.id]) return deny("Thiếu hoặc trùng id thẻ");
      if (!(p.nOpts >= 2)) return deny("Cần ít nhất 2 phương án");
      const c = newCard(m, p.id, p.flow, p.nOpts, null);
      if (p.rec !== undefined && p.rec !== null) {
        if (!(p.rec >= 0 && p.rec < p.nOpts)) return deny("Kiến nghị ngoài phạm vi phương án");
        c.rec = p.rec;
      }
      m.cards[c.id] = c; m.order.push(c.id);
      return { ok: true, model: m, from: null, to: { state: c.state, flag: null } };
    }
    const c = m.cards[ev.card];
    if (!c) return deny("Không có thẻ");
    const P = POLICY[c.flow];
    const from = { state: c.state, flag: c.flag };
    const done = () => ({ ok: true, model: m, from, to: { state: c.state, flag: c.flag } });
    if (c.discarded) return deny("Thẻ đã bỏ");
    if (c.flag === "sup") return deny("Thẻ đã bị thay thế — chỉ còn là lịch sử");

    switch (t) {
      case "RECOMMEND":
        if (!allow(ev, P.recommend)) return deny("Chỉ vai trò ADVISOR (Lượng) được kiến nghị");
        if (c.rec !== null) return deny("Kiến nghị đã ghi, không sửa (giữ truy vết)");
        if (c.state > ST.S2) return deny("Đã commit, không kiến nghị thêm");
        if (!(p.rec >= 0 && p.rec < c.nOpts)) return deny("Kiến nghị ngoài phạm vi phương án");
        c.rec = p.rec; return done();

      case "SELECT":
        if (!allow(ev, P.select)) return deny("Vai trò này không được chọn — kiến nghị không phải lựa chọn");
        if (c.flag) return deny("Thẻ đang bị chặn");
        if (c.state > ST.S2) return deny("Đã commit — toàn bộ lựa chọn đã khóa");
        if (!(p.option >= 0 && p.option < c.nOpts)) return deny("Phương án không tồn tại");
        c.sel = p.option; c.state = ST.S2; return done();

      case "COMMIT": {
        if (!allow(ev, P.commit)) return deny(c.flow === "qd" ? "Vai trò này không được ấn phê" : "Vai trò này không được truyền lệnh");
        const g = p.proof;
        if (P.commitProof === "gesture" && !(g && g.via === "ui" && g.trusted === true))
          return deny("Thiếu thao tác thật của Huynh — không tự tạo authority");
        if (c.flag) return deny("Thẻ đang bị chặn");
        if (c.state !== ST.S2 || c.sel === null) return deny("Chỉ commit được khi đã chọn (S2)");
        const rec = { option: c.sel, by: a, at: ev.ts, gesture: g.id || null, event_id: ev.event_id || null, status: "EFFECTIVE" };
        if (P.authorityRecord) c.authority = rec; else c.order = rec;
        c.state = ST.S3; c.attempt = 1; c.lastFail = null; c.execution = null;
        if (c.replaces) {                 // SUPERSEDED gắn ngay khi thẻ mới COMMIT; không tự phục hồi nếu thẻ mới sau đó bị chặn
          const o = m.cards[c.replaces];
          if (o) { o.flag = "sup"; o.supBy = c.n; o.supById = c.id; o.pendingFork = null; }
        }
        return done();
      }

      case "RUNTIME_OK":
        if (!allow(ev, P.runtime)) return deny("Chỉ vai trò RUNTIME báo kết quả — không tự đánh dấu hoàn tất");
        if (c.state !== ST.S3) return deny("Chỉ nhận kết quả khi đang thi hành");
        if (c.flag === "blk") return deny("Đang bị chặn — phải thử lại trước");
        c.state = ST.S4; c.execution = { executor: p.executor || a, reported_by: a, attempt: c.attempt, at: ev.ts };
        return done();

      case "RUNTIME_FAIL":
        if (!allow(ev, P.runtime)) return deny("Chỉ vai trò RUNTIME báo lỗi");
        if (c.state !== ST.S3 || c.flag === "blk") return deny("Chỉ báo lỗi khi đang thi hành");
        if (["none", "partial", "unknown"].indexOf(p.sideEffect) < 0) return deny("Phải nêu tác động phụ: none | partial | unknown");
        c.flag = "blk"; c.lastFail = { sideEffect: p.sideEffect, at: ev.ts, attempt: c.attempt };
        return done();                    // KHÔNG tự sang S4

      case "RETRY":                       // retry execution cùng payload đã commit — không cần ấn phê lại
        if (!allow(ev, P.control)) return deny("Vai trò này không được quyết thử lại");
        if (c.flag !== "blk") return deny("Chỉ thử lại khi bị chặn");
        c.flag = null; c.attempt += 1; return done();

      case "RECALL": {                    // quay về chọn: thu hồi approval/order cũ, phải chọn lại và commit lại
        if (!allow(ev, P.control)) return deny("Vai trò này không được thu hồi / quay về chọn");
        if (c.flag !== "blk") return deny("Chỉ quay về chọn khi bị chặn");
        if (!c.lastFail || c.lastFail.sideEffect !== "none") return deny("Không chắc chưa có tác động — chỉ được thử lại");
        const key = P.authorityRecord ? "authority" : "order";
        const old = Object.assign({}, c[key], { status: "REVOKED", revoked_at: ev.ts, revoked_by: a, revoke_event: ev.event_id || null });
        c.voided.push({ what: key, rec: old });
        c[key] = null; c.flag = null; c.state = ST.S2; return done();
      }

      case "VERIFY": {                    // verifier ≠ executor; role VERIFIER; authority_ref; evidence_ref
        if (c.state !== ST.S4 || c.flag) return deny("Chỉ kiểm chứng việc đã hoàn tất");
        if (c.verified) return deny("Đã kiểm chứng");
        const ex = c.execution || {};
        if (a === ex.executor || a === ex.reported_by) return deny("Bên thi hành không tự kiểm chứng");
        if (!allow(ev, P.verify)) return deny("Thiếu role VERIFIER");
        if (!ev.auth.grant_id) return deny("Thiếu authority_ref của verifier");
        if (!p.evidence_ref) return deny("Kiểm chứng phải có evidence_ref");
        c.verified = true;
        c.verification = { actor_id: a, role: ev.auth.role, authority_ref: ev.auth.grant_id, authority_version: ev.auth.grant_version, source_ref: ev.auth.source_ref, evidence_ref: p.evidence_ref,
                           at: ev.ts, target: { card_id: c.id, attempt: ex.attempt || null }, mock: !!p.mock, event_id: ev.event_id || null };
        return done();
      }

      case "FORK": {
        if (!allow(ev, P.control)) return deny("Vai trò này không được mở thẻ thay thế");
        if (c.state !== ST.S4 || c.flag) return deny("Chỉ mở thẻ thay thế từ thẻ hoàn tất, không bị chặn");
        if (c.pendingFork) return deny("Đang có thẻ thay thế chưa xử lý");
        if (!p.newId || m.cards[p.newId]) return deny("Thiếu hoặc trùng id thẻ mới");
        const nc = newCard(m, p.newId, c.flow, c.nOpts, c.id);
        m.cards[nc.id] = nc; m.order.push(nc.id); c.pendingFork = nc.id;
        return done();                    // thẻ cũ không đổi state/flag
      }

      case "DISCARD": {
        if (!allow(ev, P.control)) return deny("Vai trò này không được bỏ thẻ");
        if (!c.replaces) return deny("Chỉ bỏ được thẻ thay thế");
        if (c.state > ST.S2) return deny("Thẻ mới đã commit — không bỏ được");
        c.discarded = true;
        const o = m.cards[c.replaces]; if (o && o.pendingFork === c.id) o.pendingFork = null;
        return done();                    // thẻ cũ vẫn hiện hành
      }
      default: return deny("Event không hợp lệ");
    }
  }

  function domainStatus(c) {
    const P = POLICY[c.flow];
    if (c.flow === "qd") {
      if (c.flag === "sup") return "SUPERSEDED";
      if (c.flag === "blk") return "AUTHORIZED · ghi nhận lỗi";
      return P.domain[c.state] + (c.verified ? " · VERIFIED" : "");
    }
    if (c.flag === "blk") return "BLOCKED";
    const base = c.verified ? "VERIFIED" : P.domain[c.state];
    return c.flag === "sup" ? base + " · SUPERSEDED" : base;
  }

  /* Bước authority: gọi resolver, ghi basis vào event (credential KHÔNG ghi). Không có resolver → mọi event không có role → reducer từ chối. */
  function authorizeStep(authorize, e, model, cred) {
    if (!authorize) { e.auth = { decision: "NONE", reason: "Chưa cấu hình authority resolver" }; return null; }
    const d = authorize(e, model, cred);
    e.auth = d.basis;
    if (d.outcome !== "ALLOW") return { ok: false, reason: d.reason, gate: true, hold: d.outcome === "HOLD" };
    return null;
  }

  /* Machine trong bộ nhớ (test reducer nhanh) */
  function createMachine(opts) {
    opts = opts || {};
    const clock = opts.clock || (() => Date.now());
    const gates = [].concat(opts.gate || [], opts.gates || []);
    let model = empty(), log = [], seq = 0, n = 0;
    const subs = [];
    function send(ev) {
      const e = { schema: SCHEMA, event_id: ev.event_id || "E-mem-" + (++n), work_id: opts.workId || "W-MEM", seq: ++seq,
                  ts: ev.ts != null ? ev.ts : clock(), type: ev.type, card: ev.card || (ev.payload && ev.payload.id) || null,
                  actor: ev.actor, payload: ev.payload || {} };
      let r = authorizeStep(opts.authorize, e, model, ev.credential);
      if (!r) { r = reduce(model, e); if (r.ok) for (const g of gates) { const why = g(e); if (why) { r = { ok: false, reason: why, gate: true }; break; } } }
      const entry = Object.assign({}, e, { ok: r.ok, reason: r.reason || null, from: r.from || null, to: r.to || null, gate: !!r.gate, hold: !!r.hold });
      log.push(entry); if (r.ok) model = r.model;
      subs.forEach((f) => f(entry, model));
      return entry;
    }
    return { send, model: () => clone(model), card: (id) => (model.cards[id] ? clone(model.cards[id]) : null),
             log: () => clone(log), subscribe: (f) => subs.push(f), reset: () => { model = empty(); log = []; seq = 0; } };
  }

  /* Replay: dựng lại model chỉ từ log */
  function replay(log) {
    let m = empty();
    for (const e of log) { if (e.gate) continue; const r = reduce(m, e); if (r.ok !== e.ok) throw new Error("Replay lệch tại seq " + e.seq); if (r.ok) m = r.model; }
    return m;
  }

  /* ---------- RECOVERY: kiểm toàn vẹn log, dừng ở bản ghi hỏng đầu tiên, phần sau vào cách ly ---------- */
  const REQ = ["schema", "event_id", "work_id", "seq", "ts", "type", "actor", "auth", "ok", "prev_hash", "hash"];
  function recover(events, workId) {
    const sorted = (events || []).slice().sort((x, y) => (x.seq || 0) - (y.seq || 0));
    let m = empty(), prev = GENESIS, expect = 1, valid = [], quarantine = [], ids = new Set();
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      let why = null;
      for (const k of REQ) if (e[k] === undefined) { why = "Bản ghi thiếu trường " + k; break; }
      if (!why && e.schema !== SCHEMA) why = "Schema không khớp";
      if (!why && e.work_id !== workId) why = "Sai work_id";
      if (!why && e.seq !== expect) why = "Đứt chuỗi seq (chờ " + expect + ", gặp " + e.seq + ")";
      if (!why && ids.has(e.event_id)) why = "Trùng event_id";
      if (!why && e.prev_hash !== prev) why = "prev_hash không khớp";
      if (!why && hashOf(e) !== e.hash) why = "Hash không khớp — bản ghi hỏng hoặc bị sửa";
      if (!why && !e.gate && (!e.auth || e.auth.decision !== "ALLOW")) why = "Event được áp dụng nhưng thiếu authority basis ALLOW";
      let r = null;
      if (!why && !e.gate) { r = reduce(m, e); if (r.ok !== e.ok) why = "Replay không khớp kết quả đã ghi"; else if (r.ok && stable(r.to) !== stable(e.to)) why = "Replay không khớp state đích"; }
      if (why) { sorted.slice(i).forEach((x, j) => quarantine.push({ record: x, reason: j === 0 ? why : "Sau bản ghi hỏng seq " + e.seq })); break; }
      if (r && r.ok) m = r.model;
      valid.push(e); ids.add(e.event_id); prev = e.hash; expect++;
    }
    return { model: m, valid, quarantine, head: { seq: expect - 1, hash: prev } };
  }

  /* ---------- MEMORY STORE (Node test + fallback trình duyệt): cùng giao diện với IndexedDB store ---------- */
  function MemoryStore() {
    const db = { events: {}, meta: {}, quarantine: [] };
    const err = (code, msg) => Object.assign(new Error(msg || code), { code });
    const s = {
      kind: "memory", durable: false, _fault: null,
      async load(workId) {
        return { events: Object.values(db.events).filter((e) => e.work_id === workId).map(clone), meta: db.meta[workId] ? clone(db.meta[workId]) : null };
      },
      async append(workId, entry, expectedSeq) {               // nguyên tử: hoặc đủ event + meta, hoặc không gì
        const f = s._fault; s._fault = null;
        if (f === "abort") throw err("FAULT", "Mô phỏng sự cố trước khi ghi xong — giao dịch hủy");
        if (db.events[entry.event_id]) throw err("DUPLICATE");
        const head = db.meta[workId] ? db.meta[workId].head_seq : 0;
        if (head !== expectedSeq) throw err("CONFLICT", "head " + head + " ≠ " + expectedSeq);
        if (f === "torn") { const t = clone(entry); t.hash = "torn"; delete t.to; db.events[t.event_id] = t; throw err("FAULT", "Mô phỏng ghi dở (không giao dịch)"); }
        db.events[entry.event_id] = clone(entry);
        db.meta[workId] = { work_id: workId, head_seq: entry.seq, head_hash: entry.hash, updated: entry.ts };
      },
      async quarantine(workId, items, head) {
        items.forEach((q) => { delete db.events[q.record.event_id]; db.quarantine.push({ work_id: workId, record: clone(q.record), reason: q.reason }); });
        db.meta[workId] = { work_id: workId, head_seq: head.seq, head_hash: head.hash, updated: Date.now() };
      },
      async setMeta(workId, head) { db.meta[workId] = { work_id: workId, head_seq: head.seq, head_hash: head.hash, updated: Date.now() }; },
      async clear(workId) { Object.keys(db.events).forEach((k) => { if (db.events[k].work_id === workId) delete db.events[k]; }); delete db.meta[workId]; },
      async listQuarantine(workId) { return db.quarantine.filter((q) => q.work_id === workId).map(clone); },
      _raw: db
    };
    return s;
  }

  /* ---------- PERSISTENT MACHINE: persist-then-apply, idempotent theo event_id, tuần tự hóa ghi ---------- */
  function createPersistentMachine(o) {
    const store = o.store, workId = o.workId;
    const clock = o.clock || (() => Date.now());
    const idGen = o.idGen || ((p) => p + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
    const gates = [].concat(o.gate || [], o.gates || []);
    let model = empty(), log = [], seen = new Map(), head = { seq: 0, hash: GENESIS }, report = null, queue = Promise.resolve();
    const subs = [];
    const notify = (entry) => subs.forEach((f) => f(entry, model));

    async function open() {
      const raw = await store.load(workId);
      const rec = recover(raw.events, workId);
      const metaHead = raw.meta ? raw.meta.head_seq : 0;
      if (rec.quarantine.length) await store.quarantine(workId, rec.quarantine, rec.head);
      else if (metaHead !== rec.head.seq) await store.setMeta(workId, rec.head);
      model = rec.model; log = rec.valid; head = rec.head; seen = new Map(log.map((e) => [e.event_id, e]));
      report = { store: store.kind, durable: store.durable, work_id: workId, events: log.length, head_seq: head.seq, head_hash: head.hash,
                 quarantined: rec.quarantine.map((q) => ({ seq: q.record.seq, event_id: q.record.event_id, reason: q.reason })),
                 meta_fixed: !rec.quarantine.length && metaHead !== rec.head.seq ? { from: metaHead, to: rec.head.seq } : null };
      notify(null);
      return clone(report);
    }

    async function attempt(ev, id, again) {
      const e = { schema: SCHEMA, event_id: id, work_id: workId, seq: head.seq + 1, ts: ev.ts != null ? ev.ts : clock(),
                  type: ev.type, card: ev.card || (ev.payload && ev.payload.id) || null, actor: ev.actor, payload: ev.payload || {} };
      let r = authorizeStep(o.authorize, e, model, ev.credential);          // authority kiểm LÚC APPEND
      if (!r) { r = reduce(model, e); if (r.ok) for (const g of gates) { const why = g(e); if (why) { r = { ok: false, reason: why, gate: true }; break; } } }
      const entry = Object.assign({}, e, { ok: r.ok, reason: r.reason || null, from: r.from || null, to: r.to || null, gate: !!r.gate, hold: !!r.hold, prev_hash: head.hash });
      entry.hash = hashOf(entry);
      try { await store.append(workId, entry, head.seq); }
      catch (err) {
        if (err && (err.code === "DUPLICATE" || err.code === "CONFLICT") && !again) {
          await open();                                         // tab khác vừa ghi: đồng bộ lại rồi xét lại
          if (seen.has(id)) return Object.assign(clone(seen.get(id)), { duplicate: true });
          return attempt(ev, id, true);
        }
        return Object.assign(entry, { ok: false, persisted: false, persistError: (err && (err.code || err.message)) || String(err) }); // state KHÔNG đổi
      }
      log.push(entry); seen.set(id, entry); head = { seq: entry.seq, hash: entry.hash };
      if (r.ok) model = r.model;
      notify(entry);
      return clone(entry);
    }

    function send(ev) {
      const id = ev.event_id || idGen("E");
      const run = () => (seen.has(id) ? Object.assign(clone(seen.get(id)), { duplicate: true }) : attempt(ev, id, false));
      const p = queue.then(run);
      queue = p.catch(() => {});
      return p;
    }

    return {
      open, send,
      model: () => clone(model), card: (id) => (model.cards[id] ? clone(model.cards[id]) : null),
      log: () => clone(log), head: () => clone(head), report: () => clone(report),
      subscribe: (f) => subs.push(f), idle: () => queue,
      resync() { const p = queue.then(open); queue = p.catch(() => {}); return p; },   // tab khác vừa ghi → dựng lại từ kho
      async reset() { await queue; await store.clear(workId); return open(); }
    };
  }

  return { SCHEMA, ST, STATE_NAME, POLICY, reduce, replay, recover, hashOf, stable, createMachine, createPersistentMachine,
           MemoryStore, domainStatus, empty, who, version: "candidate-0.2" };
});

/* CCL BEHAVIOR STORE · IndexedDB (trình duyệt) — cùng giao diện MemoryStore
   - Mỗi append = MỘT giao dịch readwrite gồm event + meta → hoặc đủ cả hai, hoặc không gì (không có state nửa vời).
   - durability:"strict" (Chromium): giao dịch chỉ báo xong khi đã flush xuống đĩa.
   - Chỉ lưu EVENT + meta head. Không lưu snapshot state.
   - Bền trong MỘT trình duyệt / một hồ sơ người dùng; không đồng bộ giữa máy; có thể bị xóa khi dọn dữ liệu trang. */
(function (root) {
  "use strict";
  const err = (code, msg) => Object.assign(new Error(msg || code), { code });
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function openIdbStore(name) {
    if (!root.indexedDB) throw err("NO_IDB", "Trình duyệt không có IndexedDB");
    const db = await new Promise((res, rej) => {
      const r = root.indexedDB.open(name || "ccl_behavior_v1", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        const ev = d.createObjectStore("events", { keyPath: "event_id" });
        ev.createIndex("work_seq", ["work_id", "seq"], { unique: true });   // không thể có 2 event cùng seq trong một work
        ev.createIndex("work", "work_id");
        d.createObjectStore("meta", { keyPath: "work_id" });
        d.createObjectStore("quarantine", { keyPath: "qid", autoIncrement: true }).createIndex("work", "work_id");
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(err("BLOCKED"));
    });
    const tx = (stores, mode) => { try { return db.transaction(stores, mode, { durability: "strict" }); } catch (e) { return db.transaction(stores, mode); } };
    const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onabort = () => rej(t.error || err("ABORT")); });
    const s = {
      kind: "indexeddb", durable: true, _fault: null,
      async load(workId) {
        const t = tx(["events", "meta"], "readonly");
        const [events, meta] = await Promise.all([req(t.objectStore("events").index("work").getAll(workId)), req(t.objectStore("meta").get(workId))]);
        return { events, meta: meta || null };
      },
      append(workId, entry, expectedSeq) {
        const f = s._fault; s._fault = null;
        const t = tx(["events", "meta"], "readwrite"), E = t.objectStore("events"), M = t.objectStore("meta");
        let code = null;
        const p = done(t);
        const g = E.get(entry.event_id);
        g.onsuccess = () => {
          if (g.result) { code = "DUPLICATE"; t.abort(); return; }
          const mg = M.get(workId);
          mg.onsuccess = () => {
            const head = mg.result ? mg.result.head_seq : 0;
            if (head !== expectedSeq) { code = "CONFLICT"; t.abort(); return; }
            const a = E.add(entry);
            a.onerror = () => { code = "CONFLICT"; };
            a.onsuccess = () => {
              if (f === "abortAfterAdd") { code = "FAULT"; t.abort(); return; }   // TEST: sự cố giữa giao dịch (event đã add, meta chưa)
              M.put({ work_id: workId, head_seq: entry.seq, head_hash: entry.hash, updated: entry.ts });
            };
          };
        };
        return p.catch((e) => { throw err(code || "IDB_ERROR", (e && (e.name || e.message)) || code); });
      },
      async quarantine(workId, items, head) {
        const t = tx(["events", "meta", "quarantine"], "readwrite");
        items.forEach((q) => { t.objectStore("events").delete(q.record.event_id); t.objectStore("quarantine").add({ work_id: workId, record: q.record, reason: q.reason, at: Date.now() }); });
        t.objectStore("meta").put({ work_id: workId, head_seq: head.seq, head_hash: head.hash, updated: Date.now() });
        return done(t);
      },
      async setMeta(workId, head) { const t = tx(["meta"], "readwrite"); t.objectStore("meta").put({ work_id: workId, head_seq: head.seq, head_hash: head.hash, updated: Date.now() }); return done(t); },
      async clear(workId) {
        const t = tx(["events", "meta"], "readwrite"), E = t.objectStore("events");
        const r = E.index("work").getAllKeys(workId); r.onsuccess = () => r.result.forEach((k) => E.delete(k));
        t.objectStore("meta").delete(workId); return done(t);
      },
      async listQuarantine(workId) { const t = tx(["quarantine"], "readonly"); return req(t.objectStore("quarantine").index("work").getAll(workId)); },
      /* TEST ONLY — mô phỏng bản ghi hỏng / meta sai nằm sẵn trong kho */
      async _rawPut(record) { const t = tx(["events"], "readwrite"); t.objectStore("events").put(record); return done(t); },
      async _rawMeta(workId, seq) { const t = tx(["meta"], "readwrite"); t.objectStore("meta").put({ work_id: workId, head_seq: seq, head_hash: "x", updated: Date.now() }); return done(t); }
    };
    return s;
  }
  root.CCL_IDB = { openIdbStore };
})(typeof self !== "undefined" ? self : this);

/* CCL IDENTITY + AUTHORITY · candidate v0.1
   ACTOR ≠ ROLE ≠ AUTHORITY.
   - Danh tính: actor_id chỉ được công nhận qua credential do Identity Provider cấp (candidate: IdP MOCK, trong bộ nhớ).
     Nhãn trên event, tên hiển thị, click thật, việc đang cầm thẻ: KHÔNG phải bằng chứng authority.
   - Authority: grant theo actor_id × role × work_id × scope × authority_type × source_ref × status × delegation × hiệu lực × version.
   - Kiểm tại thời điểm APPEND. Kết quả (basis) ghi vào event → replay dùng basis đã ghi, không xét lại theo luật hiện tại.
   Provider-neutral: không DOM, không mạng. Chạy được trong trình duyệt và Node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CCL_AUTH = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* Hành vi → loại authority cần có */
  function authorityTypeOf(e, model) {
    const c = e.card && model && model.cards ? model.cards[e.card] : null;
    switch (e.type) {
      case "CREATE": return "PROPOSE";
      case "RECOMMEND": return "RECOMMEND";
      case "SELECT": return "SELECT";
      case "COMMIT": return c && c.flow === "qd" ? "APPROVE" : "COMMAND";
      case "RETRY": return "RETRY";
      case "RECALL": return "REVOKE";
      case "FORK": return "FORK";
      case "DISCARD": return "DISCARD";
      case "RUNTIME_OK": case "RUNTIME_FAIL": return "REPORT_EXECUTION";
      case "VERIFY": return "VERIFY";
      default: return "UNKNOWN";
    }
  }
  const flowOf = (e, model) => (e.card && model && model.cards && model.cards[e.card] ? model.cards[e.card].flow : (e.payload && e.payload.flow) || null);

  /* ---------- IDENTITY PROVIDER (MOCK) ---------- */
  function createIdentityProvider(identities, opts) {
    opts = opts || {};
    const ids = {}; (identities || []).forEach((i) => (ids[i.actor_id] = clone(i)));
    const sessions = {};
    const rnd = opts.rnd || (() => Math.random().toString(36).slice(2, 12));
    const now = opts.clock || (() => Date.now());
    let n = 0;
    return {
      kind: "mock-idp",
      login(actor_id, ttlMs) {                       // MOCK: không mật khẩu / không SSO — chỉ để có credential tách khỏi nhãn
        const who = ids[actor_id]; if (!who || who.status !== "ACTIVE") return null;
        const s = { session_id: "S-" + (++n) + "-" + rnd().slice(0, 6), secret: rnd() + rnd(), actor_id, issued_at: now(), expires_at: ttlMs ? now() + ttlMs : null, revoked: false };
        sessions[s.session_id] = s;
        return { session_id: s.session_id, secret: s.secret };
      },
      check(cred, at) {
        if (!cred || !cred.session_id) return { ok: false, reason: "Không có danh tính (actor UNKNOWN)" };
        const s = sessions[cred.session_id];
        if (!s || s.secret !== cred.secret) return { ok: false, reason: "Credential không hợp lệ (actor UNKNOWN)" };
        if (s.revoked) return { ok: false, reason: "Phiên đã bị thu hồi" };
        if (s.expires_at && (at != null ? at : now()) > s.expires_at) return { ok: false, reason: "Phiên đã hết hạn" };
        const who = ids[s.actor_id];
        if (!who || who.status !== "ACTIVE") return { ok: false, reason: "Actor không còn hiệu lực" };
        return { ok: true, actor_id: s.actor_id, session_id: s.session_id, kind: who.kind };
      },
      revokeSession(session_id) { if (sessions[session_id]) sessions[session_id].revoked = true; },
      identity: (actor_id) => (ids[actor_id] ? clone(ids[actor_id]) : null)
    };
  }

  /* ---------- AUTHORITY REGISTRY + RESOLVER ---------- */
  function createAuthority(o) {
    const idp = o.idp;
    let version = o.version || 1;
    const grants = {}; (o.grants || []).forEach((g) => (grants[g.grant_id] = Object.assign({ version: 1, status: "ACTIVE" }, clone(g))));
    const validAt = (g, at) => !(g.effective_from && at < g.effective_from) && !(g.effective_to && at > g.effective_to);

    function check(g, e, type, flow, at, depth) {
      if (g.status !== "ACTIVE") return { fail: "DENY", why: "Quyền " + g.grant_id + " đã " + (g.status === "REVOKED" ? "bị thu hồi" : "tạm dừng") };
      if (!validAt(g, at)) return { fail: "DENY", why: "Quyền " + g.grant_id + " ngoài thời hạn hiệu lực" };
      if (g.work_id !== e.work_id) return { fail: "DENY", why: "Quyền " + g.grant_id + " thuộc work item khác" };
      if (g.scope && g.scope.flows && flow && g.scope.flows.indexOf(flow) < 0) return { fail: "DENY", why: "Quyền " + g.grant_id + " không phủ loại thẻ này" };
      if (g.scope && g.scope.cards && e.card && g.scope.cards.indexOf(e.card) < 0) return { fail: "DENY", why: "Quyền " + g.grant_id + " không phủ thẻ này" };
      if (g.delegation) {
        const d = g.delegation, parent = grants[d.from_grant];
        if (!parent || depth > 3) return { fail: "DENY", why: "Ủy nhiệm không có quyền gốc hợp lệ" };
        const pr = check(parent, e, type, flow, at, depth + 1);
        if (pr.fail) return { fail: "DENY", why: "Quyền gốc của ủy nhiệm không còn hợp lệ: " + pr.why };
        if (parent.authority_types.indexOf(type) < 0) return { fail: "DENY", why: "Quyền gốc không có " + type };
        if (d.level === "LIMITED") {
          const L = d.limits || {};
          if ((L.types && L.types.indexOf(type) < 0) || (L.flows && flow && L.flows.indexOf(flow) < 0))
            return { fail: "HOLD", why: "Ủy nhiệm giới hạn không phủ " + type + (flow ? " / " + flow : "") + " — cần người có quyền gốc xác nhận" };
        }
      }
      return { fail: null };
    }

    function resolve(e, model, cred) {
      const at = e.ts;
      const type = authorityTypeOf(e, model), flow = flowOf(e, model);
      const base = { actor_id: e.actor, authority_type: type, work_id: e.work_id, registry_version: version, resolved_at: at };
      const id = idp.check(cred, at);
      if (!id.ok) return { outcome: "DENY", reason: id.reason, basis: Object.assign(base, { decision: "DENY", identity: null }) };
      if (id.actor_id !== e.actor) return { outcome: "DENY", reason: "Nhãn actor trên event không khớp danh tính đã xác thực", basis: Object.assign(base, { decision: "DENY", identity: { actor_id: id.actor_id, session_id: id.session_id } }) };
      const identity = { actor_id: id.actor_id, method: idp.kind, session_id: id.session_id };
      if (type === "UNKNOWN") return { outcome: "DENY", reason: "Hành vi không có trong bảng authority", basis: Object.assign(base, { decision: "DENY", identity }) };
      const cands = Object.values(grants).filter((g) => g.actor_id === e.actor && g.authority_types.indexOf(type) >= 0);
      if (!cands.length) return { outcome: "DENY", reason: "Không có quyền " + type + " cho actor này", basis: Object.assign(base, { decision: "DENY", identity }) };
      let hold = null, deny = null;
      for (const g of cands) {
        const r = check(g, e, type, flow, at, 0);
        if (!r.fail) {
          return { outcome: "ALLOW", reason: null, basis: Object.assign(base, {
            decision: "ALLOW", identity, role: g.role, grant_id: g.grant_id, grant_version: g.version, source_ref: g.source_ref,
            scope: g.scope || null, delegation: g.delegation ? { from_grant: g.delegation.from_grant, level: g.delegation.level } : null,
            effective: { from: g.effective_from || null, to: g.effective_to || null } }) };
        }
        if (r.fail === "HOLD" && !hold) hold = r.why; else if (!deny) deny = r.why;
      }
      if (hold) return { outcome: "HOLD", reason: hold, basis: Object.assign(base, { decision: "HOLD", identity }) };
      return { outcome: "DENY", reason: deny, basis: Object.assign(base, { decision: "DENY", identity }) };
    }

    const bump = (g) => { g.version += 1; version += 1; };
    return {
      resolve,
      revoke(grant_id) { const g = grants[grant_id]; if (g && g.status !== "REVOKED") { g.status = "REVOKED"; bump(g); } },
      suspend(grant_id) { const g = grants[grant_id]; if (g) { g.status = "SUSPENDED"; bump(g); } },
      setEffective(grant_id, from, to) { const g = grants[grant_id]; if (g) { g.effective_from = from; g.effective_to = to; bump(g); } },
      add(g) { grants[g.grant_id] = Object.assign({ version: 1, status: "ACTIVE" }, clone(g)); version += 1; },
      version: () => version,
      grants: () => clone(Object.values(grants)),
      /* Cắm vào machine: authorize(event, model, credential) */
      authorize: (e, model, cred) => resolve(e, model, cred)
    };
  }

  return { authorityTypeOf, createIdentityProvider, createAuthority, version: "candidate-0.1" };
});

/*CCL_SM:END*/
var CCL_A=(window.CCL_BASE||(function(){var c=document.currentScript;return c&&c.src?c.src.replace(/[^/]*$/,""):"";})())+"assets/";

/* Template chỉ nhận dữ liệu. Claude chỉ đổi STATE mỗi lượt. */
/* MOCK RUNTIME — chưa nối state machine. Entry đọc state từ đây; không hard-code "chờ quyết".
   Đổi thử bằng ?state=IDLE|ACTIVE|REPORT|DECISION_REQUIRED|EXECUTING */
const SYSTEM_STATES={
  IDLE:{chip:"Chờ lệnh",title:"Sẵn sàng nhận lệnh",lead:"Chưa có lệnh đang chạy. Lượng giữ mạch và chờ Huynh ra lệnh.",
        kicker:"Soái Lệnh · Chờ lệnh",point:"Chưa có điểm nối nào mở",text:"Lệnh tiếp theo sẽ hiện ở đây khi có việc cần Huynh.",sub:"Sẵn sàng nhận lệnh",status:null},
  ACTIVE:{chip:"Đang triển khai",title:"Đang triển khai",lead:"Lượng đang giữ mạch và xử lý lệnh hiện tại.",
        kicker:"Soái Lệnh · Đang triển khai",point:"Lượng đang xử lý lệnh",text:"Chưa có điểm nào cần Huynh quyết.",sub:"Theo dõi mạch",status:"DUNG_BINH"},
  REPORT:{chip:"Có hồi báo",title:"Có hồi báo mới",lead:"Lượng giữ mạch việc. Hồi báo mới nhất nằm ở lượt trả lời bên dưới.",
        kicker:"Soái Lệnh · Có hồi báo",point:"Hồi báo mới đã về",text:"Chưa có điểm nào đang chờ Huynh quyết.",sub:"Xem hồi báo",status:"HOI_BAO"},
  DECISION_REQUIRED:{chip:"Chờ Huynh quyết",title:"Cần Huynh quyết",lead:"Lượng đã chuẩn bị xong và dừng ở điểm cần Huynh.",
        kicker:"Soái Lệnh · Chờ Huynh quyết",point:"Một việc đang chờ Huynh quyết",text:"Điểm nối nằm ở lượt trả lời mới nhất bên dưới.",sub:"Mở điểm nối",status:"SOAI_LENH"},
  NONE:{chip:"Chưa nối việc",title:"Chưa có việc thật được nối",lead:"Giao diện này chưa nối với Mạch Việc nào, nên chưa có dữ liệu để hiển thị.",
        kicker:"Soái Lệnh · Chưa nối việc",point:"Chưa có việc thật được nối",text:"Lệnh và điểm quyết chỉ hiện ở đây khi có việc thật được nối.",sub:"Chưa có việc",status:null},
  EXECUTING:{chip:"Đang thi hành",title:"Đang thi hành",lead:"Lệnh đã giao, Lượng đang thi hành và giữ mạch.",
        kicker:"Soái Lệnh · Đang thi hành",point:"Việc đang được thi hành",text:"Hồi báo sẽ về khi xong từng nhánh.",sub:"Theo dõi thi hành",status:"BINH_KHI"}
};
const _q=new URLSearchParams(location.search);
/* NORMAL vs DEMO/DEV: công tắc dev có sẵn (?proto ?test ?state ?log ?dbg ?ba) mở DEV. Không có → NORMAL: không mock, không bảng thử, không verifier giả, không reset/log. */
const DEV=true;   /* CHAT-NATIVE FULL MODE (P016 §1) */
const PROTO=DEV;   /* DEV: PROTOTYPE behavior 4 state × 2 flow (candidate, chưa activation) */
if(_q.get("dbg"))document.documentElement.classList.add("dbg");
const RUNTIME={state:DEV?(SYSTEM_STATES[_q.get("state")]?_q.get("state"):"REPORT"):"NONE", scope:"r3"};   /* scope = lượt làm việc hiện hành (do logic ngữ cảnh đặt, không do viewport) */
if(PROTO)RUNTIME.scope="p1";
const ENTRY_MOCK=_q.has("state");   /* ?state=… → entry mock như cũ (công cụ dev). Không có → entry đọc từ model state machine. */
const _S=SYSTEM_STATES[RUNTIME.state];
/* status = TRẠNG THÁI của Mạch (chấm nhỏ). Khác với active = VỊ TRÍ đang đọc (gạch chân, do scroll spy). Mapping state→mục là MOCK. */
const STATE={mode:RUNTIME.state, status:_S.status,
  hero:{status:_S.chip,kicker:"CCL · Command Surface",motto:"Tầm nhìn · Chiến lược · Thống nhất · Hiệu quả",title:_S.title,lead:_S.lead},
  soai:{kicker:_S.kicker,point:_S.point,text:_S.text,cta:"Soái Lệnh",sub:_S.sub}};
/* BEHAVIOR ASSET — chỉ SLOT + COMPONENT + FALLBACK. Chưa gắn state/behavior thật.
   Asset = vật thể ngữ nghĩa trong suốt, vuông (ưu tiên 512/1024). Mọi state (available/active/pending/confirmed/disabled/error) do UI/runtime vẽ riêng, KHÔNG nằm trong file. */
const BA_DIR=CCL_A+"behavior/";
const BEHAVIOR_ASSETS={
  "the-lenh":      {file:"behavior-the-lenh.webp",        sem:"Thẻ Lệnh",              group:"Soái Lệnh"},
  "linh-menh":     {file:"behavior-linh-menh.webp",       sem:"Lĩnh Mệnh",             group:"Soái Lệnh"},
  "dang-thi-hanh": {file:"behavior-dang-thi-hanh.webp",   sem:"Đang Thi Hành",         group:"Soái Lệnh"},
  "can-quyet":     {file:"decision-can-quyet.webp",       sem:"Cần Quyết",             group:"Quyết Định"},
  "an-phe":        {file:"decision-an-phe.webp",          sem:"Ấn Phê",                group:"Quyết Định"},
  "dong-an":       {file:"decision-dong-an.webp",         sem:"Đóng Ấn / Chờ ghi nhận",group:"Quyết Định"},
  "da-phe":        {file:"decision-da-phe.webp",          sem:"Đã Phê",                group:"Quyết Định"},
  "runtime-ok":    {file:"status-runtime-confirmed.webp", sem:"Dấu ✓ runtime",         group:"Runtime"},   /* LỚP RIÊNG — không bake vào da-phe */
  /* FLOW 4 STATE (prototype). Phần tử 1 = file final sẽ giao; phần tử sau = asset cũ dùng TẠM nếu gần nghĩa; không có → fallback nét đứt. */
  "sl-1":{file:["sl-1-the-quan-lenh.webp","behavior-the-lenh.webp"],sem:"Thẻ quân lệnh",group:"Soái Lệnh · S1"},
  "sl-2":{file:["sl-2-trao-the.webp"],sem:"Quân sư trao thẻ · võ tướng quỳ nhận",group:"Soái Lệnh · S2"},
  "sl-3":{file:["sl-3-bach-ma.webp","behavior-dang-thi-hanh.webp"],sem:"Võ tướng cầm thẻ phi bạch mã",group:"Soái Lệnh · S3"},
  "sl-4":{file:["sl-4-hoi-doanh.webp"],sem:"Võ tướng hồi doanh · hoàn mệnh",group:"Soái Lệnh · S4"},
  "qd-1":{file:["qd-1-ngoc-ty-cho.webp","decision-can-quyet.webp"],sem:"Ngọc tỷ cạnh văn thư chưa đóng",group:"Quyết Định · S1"},
  "qd-2":{file:["qd-2-ngoc-ty-nang.webp","decision-an-phe.webp"],sem:"Ngọc tỷ nâng, chưa chạm, chưa mực",group:"Quyết Định · S2"},
  "qd-3":{file:["qd-3-an-cham-giay.webp","decision-dong-an.webp"],sem:"Ấn chạm giấy, mực son bắt đầu in",group:"Quyết Định · S3"},
  "qd-4":{file:["qd-4-dau-son.webp","decision-da-phe.webp"],sem:"Văn thư dấu son hoàn tất",group:"Quyết Định · S4"}
};
const BA_SCALE={};   /* hook cân mắt riêng từng asset, ví dụ {"linh-menh":1.06}; mặc định 1 */
const BA_ONERR="var l=(this.dataset.alts||'').split('|').filter(Boolean);if(l.length){this.src=BA_DIR+l.shift();this.dataset.alts=l.join('|');this.parentNode.classList.add('tmp');return}var f=document.createElement('span');f.className='ba-fb';f.textContent=this.dataset.sem;this.parentNode.classList.add('miss');this.replaceWith(f)";
function BA(key,o={}){
  const a=BEHAVIOR_ASSETS[key];if(!a)return"";
  const bw=o.size?`--bw:${o.size}px;`:"",bs=`--bs:${o.scale||BA_SCALE[key]||1}`;
  const fs=[].concat(a.file);
  return `<span class="ba" data-ba="${key}" style="${bw}${bs}"><img src="${BA_DIR}${fs[0]}" data-alts="${fs.slice(1).join("|")}" alt="${esc(o.alt||a.sem)}" data-sem="${esc(a.sem)}" onerror="${BA_ONERR}"></span>`;
}
/* Dấu ✓ (VERIFIED): chỉ ghép khi state machine ghi VERIFIED hợp lệ (verifier ≠ bên thi hành, có evidence). Candidate: nguồn VERIFY còn là verifier giả lập. */
const BA_CONFIRM=(confirmed,o)=>confirmed===true?BA("runtime-ok",o):"";
/* [id, file, nhãn, hệ số cân khối bằng mắt] — không crop, chỉ phóng trong ô */
/* MINI ICON SLOT — asset trong suốt, không bake nền/disc/pip/gạch chân/chấm/glow. Chưa có file mini → tự dùng icon chính (fallback tạm). Mọi state (active, status, disabled, hover/focus) do UI render, không nằm trong asset. */
const MINI_DIR=CCL_A+"mini/";
/* Cân mắt quang học riêng cho mini (±8% tối đa), do UI áp — không sửa asset. Mặc định 1. */
const MINI_SCALE={"hoi-bao":.93,"binh-luc":1.08,"binh-khi":1.08,"soai-lenh":1.05,"binh-phap":1.04};
const RAIL=[["QUAN_BAO","quan-bao","Quân Báo",1.00],["THE_TRAN","the-tran","Thế Trận",1.16],["DUNG_BINH","dung-binh","Dụng Binh",1.02],
 ["BINH_PHAP","binh-phap","Binh Pháp",1.00],["BINH_LUC","binh-luc","Binh Lực",1.18],["BINH_KHI","binh-khi","Binh Khí",1.08],
 ["HOI_BAO","hoi-bao","Hồi Báo",1.00],["CHIEN_BAO","chien-bao","Chiến Báo",1.10],["SOAI_LENH","soai-lenh","Soái Lệnh",1.00]];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function item([id,f,name,s]){
  const st=id===STATE.status;
  return `<div class="it${st?" st":""}" data-sem="${id}">
    <div class="ic"><img src="${CCL_A}icon-${f}.webp" alt="" width="72" height="72" style="--s:${s}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${name.split(' ').map(w=>w[0]).join('')}',style:'font:600 18px var(--serif);color:var(--deco);display:grid;place-items:center;height:100%'}))"></div>
    <div class="lb">${name}</div></div>`;
}
const MOCK=DEV;   /* nội dung giả lập chỉ để kiểm layout WORK MODE — KHÔNG phải dữ liệu dự án */
const tag=(c,t)=>`<span class="st-${c}">${t}</span>`;
const ul=n=>`<ul>${n.map(x=>`<li>${x}</li>`).join("")}</ul>`;
const P=t=>`<p>${t}</p>`;
/* Mỗi response có SCOPE riêng: data-resp. Section ngữ nghĩa = .ssec[data-sem] nằm TRONG response; id duy nhất theo response. */
const SP=(r,id,title,body)=>`<section class="ssec" id="s-${r}-${id}" data-sem="${id}"><h3 class="sh">${title}</h3>${body}</section>`;       /* section thường, không accordion */
const SD=(r,id,title,body,open)=>`<div class="acc"><details class="ssec" id="s-${r}-${id}" data-sem="${id}"${open?" open":""}><summary>${title}</summary><div class="d">${body}</div></details></div>`;  /* chỉ khi dài/kỹ thuật */
const AD=(title,body)=>`<div class="acc"><details><summary>${title}</summary><div class="d">${body}</div></details></div>`;                         /* accordion phụ, không phải target rail */
const EV=(t,c)=>`<blockquote class="ev"><p>${t}</p><cite>${c}</cite></blockquote>`;
const TB=(h,rows)=>`<div class="tbl"><table><thead><tr>${h.map(x=>`<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const HY=t=>`<article class="turn huynh"><div class="who">Huynh</div><div class="msg"><p>${t}</p></div></article>`;
const LU=(r,body,secs)=>`<article class="turn luong" data-resp="${r}" data-secs="${secs}"><div class="who">Lượng</div><div class="msg">${body}</div></article>`;

const _W=(window.CCL_DATA&&window.CCL_DATA.work)||{};
const PROTO_WORK=`
<section class="work" data-tier="stream" aria-label="Hội thoại"><div class="work-in">
${HY(_W.hy?esc(_W.hy):"[MOCK] Rà xong thì trình ta điểm nối và điểm quyết.")}
${LU("p1",`
  ${P(_W.lu?esc(_W.lu):"[MOCK] Lượng đã rà xong. Có một lệnh cần Huynh truyền và một điểm cần Huynh phê. Hai thẻ dưới đây là PROTOTYPE hành vi để thử, chưa nối runtime.")}
  ${SP("p1","SOAI_LENH","Soái Lệnh · điểm nối",P(_W.sl?esc(_W.sl):"[MOCK] Lệnh tiếp theo cho mạch rà soát:")+`<div class="bp" id="bp-sl"></div>`)}
  <h3 class="sh">Quyết Định · điểm quyết</h3>${P(_W.qd?esc(_W.qd):"[MOCK] Điểm thuộc authority của Huynh:")}<div class="bp" id="bp-qd"></div>
`,"SOAI_LENH")}
  <span class="mock-tag" style="margin-top:28px">BEHAVIOR STATE MACHINE · candidate v0.3 + entry nối model · event log lưu trong trình duyệt · danh tính / authority / runtime / verifier còn MOCK · khung xanh nét đứt = bảng thử</span><span class="mock-tag" id="smStore" style="margin-top:8px;display:block"></span>
  <div style="margin-top:10px"><button class="bc-sec" id="bpReset" type="button">Đặt lại prototype</button></div>
</div></section>`;
const WORK=PROTO?PROTO_WORK:MOCK?`
<section class="work" data-tier="stream" aria-label="Hội thoại"><div class="work-in">

${HY("[MOCK] Rà giúp ta hạng mục kiểm vừa gửi: căn cứ là gì, hiện trạng ra sao, và nên xử lý thế nào. Cái nào chưa chắc thì nói rõ.")}

${LU("r1",`
  ${P(`[MOCK] Lượng đã rà xong. Kết luận trước: hạng mục này <b>chưa thể chốt đạt</b> vì còn một căn cứ chưa đủ. Chi tiết theo từng phần bên dưới.`)}
  ${SP("r1","QUAN_BAO","Quân Báo · căn cứ",
     P("[MOCK] Nguồn đã đọc và trạng thái từng nguồn:")+
     TB(["Nguồn","Vai trò","Trạng thái"],[["[MOCK] Nguồn A","Hồ sơ gốc",tag("ok","ĐÃ XÁC NHẬN")],["[MOCK] Nguồn B","Bản cập nhật",tag("chk","CẦN KIỂM CHỨNG")],["[MOCK] Nguồn C","Tham chiếu ngoài",tag("no","CHƯA ĐỦ CĂN CỨ")]])+
     EV("[MOCK] “Trích đoạn nguyên văn minh họa từ nguồn A, để thử cách thể hiện bằng chứng trong dòng hội thoại.”","Nguồn A · [MOCK] mục 3")+
     P("[MOCK] Nguồn B mới hơn nhưng chưa có dấu hiệu hiệu lực; Lượng không coi mới hơn là hiệu lực."))}
  ${SP("r1","THE_TRAN","Thế Trận · hiện trạng",
     P("[MOCK] Hiện trạng theo những gì nguồn A cho thấy, tách khỏi suy luận:")+
     ul(["[MOCK] Dữ kiện 1 — mô tả giả lập, dùng để thử ngắt dòng và nhịp đọc.","[MOCK] Dữ kiện 2 — mô tả giả lập, dùng để thử ngắt dòng và nhịp đọc.","[MOCK] Dữ kiện 3 — mô tả giả lập, dùng để thử ngắt dòng và nhịp đọc."])+
     P("[MOCK] Suy luận (không phải dữ kiện): nếu nguồn B có hiệu lực thì kết quả đổi chiều."))}
  ${SP("r1","BINH_PHAP","Binh Pháp · đề xuất",
     P("[MOCK] Hai hướng xử lý, kèm cái giá của từng hướng:")+
     `<ol><li>[MOCK] Hướng 1 — xin xác nhận hiệu lực nguồn B trước khi kết luận. Chậm hơn, nhưng chắc.</li><li>[MOCK] Hướng 2 — kết luận tạm theo nguồn A, ghi rõ giả định. Nhanh, nhưng phải thu hồi nếu B có hiệu lực.</li></ol>`)}
  ${SP("r1","HOI_BAO","Hồi Báo · kết quả rà",
     P("[MOCK] Kết quả từng điểm đã rà:")+
     TB(["Điểm","Kiểm","Kết quả"],[1,2,3,4,5,6].map((n,i)=>[`[MOCK] Điểm ${n}`,"Giá trị mô phỏng",tag(["ok","chk","ok","no","chk","ok"][i],["ĐẠT","CẦN KIỂM CHỨNG","ĐẠT","KHÔNG ĐẠT","CẦN KIỂM CHỨNG","ĐẠT"][i])]))+
     P("[MOCK] Còn mở: điểm 4 không đạt theo nguồn A; điểm 2 và 5 phụ thuộc nguồn B.")+
     AD("Ghi chú bằng chứng (5)",ul([1,2,3,4,5].map(i=>`[MOCK] Ghi chú bằng chứng ${i} — văn bản giả, dài, nên gập lại.`))))}
  ${SP("r1","SOAI_LENH","Soái Lệnh · điểm nối",
     P("[MOCK] Việc cần đến Huynh ở đây:")+
     `<div class="dcard"><b>Chọn hướng xử lý</b>${ul(["[MOCK] Hướng 1 — xin xác nhận nguồn B.","[MOCK] Hướng 2 — kết luận tạm theo nguồn A."])}<p>Khuyến nghị của Lượng: hướng 1. Chưa chọn, chưa phê.</p></div>`)}
`,"QUAN_BAO,THE_TRAN,BINH_PHAP,HOI_BAO,SOAI_LENH")}

${HY("[MOCK] Hướng 1. Xin xác nhận nguồn B trước, rồi triển khai phần còn lại.")}

${LU("r2",`${P("[MOCK] Đã ghi nhận hướng 1. Lượng sẽ xin xác nhận hiệu lực nguồn B trước, rồi mới rà tiếp. Chưa có kết luận mới ở lượt này.")}`,"")}

${HY("[MOCK] Nguồn B đã được xác nhận có hiệu lực. Triển khai rà lại và cho ta xem cách Lượng huy động.")}

${LU("r3",`
  ${P(`[MOCK] Với nguồn B có hiệu lực, Lượng đã rà lại. Kết luận trước: điểm 2 và 5 <b>chuyển sang đạt</b>; điểm 4 vẫn <b>không đạt</b> và cần Huynh xem.`)}
  ${SP("r3","DUNG_BINH","Dụng Binh · cách tổ chức",
     P("[MOCK] Lượng tổ chức trận rà lại theo ba bước, mỗi bước có nguồn riêng:")+
     `<ol><li>[MOCK] Cập nhật baseline theo nguồn B.</li><li>[MOCK] Đo lại các điểm bị ảnh hưởng.</li><li>[MOCK] So sánh cũ/mới, giữ lịch sử, không ghi đè bằng chứng.</li></ol>`)}
  ${SP("r3","BINH_LUC","Binh Lực · năng lực huy động",
     P("[MOCK] Năng lực dùng cho lượt này:")+
     ul(["[MOCK] Đọc cấu trúc hồ sơ — đủ dùng, đã kiểm.","[MOCK] So sánh revision cũ/mới — đủ dùng.","[MOCK] Đối chiếu căn cứ quy định — <b>chưa kiểm chứng</b>, ghi rõ ở Hồi Báo."]))}
  ${SD("r3","BINH_KHI","Binh Khí · chi tiết kỹ thuật",
     P("[MOCK] Công cụ và tham số đã dùng, gập lại vì dài và mang tính kỹ thuật:")+
     ul([1,2,3,4].map(i=>`[MOCK] Công cụ ${i} — tham số mô phỏng, phiên bản mô phỏng, đầu ra mô phỏng, dùng để thử độ dài khi mở.`))+
     EV("[MOCK] Nhật ký chạy mô phỏng — không phải dữ liệu thật.","Binh Khí · [MOCK] lần chạy 2"),false)}
  ${SP("r3","HOI_BAO","Hồi Báo · kết quả rà lại",
     P("[MOCK] So sánh cũ/mới ở các điểm bị ảnh hưởng:")+
     TB(["Điểm","Cũ","Mới"],[["[MOCK] Điểm 2",tag("chk","CẦN KIỂM CHỨNG"),tag("ok","ĐẠT")],["[MOCK] Điểm 4",tag("no","KHÔNG ĐẠT"),tag("no","KHÔNG ĐẠT")],["[MOCK] Điểm 5",tag("chk","CẦN KIỂM CHỨNG"),tag("ok","ĐẠT")]])+
     P("[MOCK] Điểm 4 không đổi chiều dù nguồn B có hiệu lực. Đây là phần cần xem tiếp.")+
     ul([1,2,3].map(i=>`[MOCK] Ghi chú kết quả ${i} — văn bản giả để thử độ dài và khoảng thở khi đọc nhiều màn.`)))}
  ${SP("r3","CHIEN_BAO","Chiến Báo · đại cục",
     P("[MOCK] Gộp lại: hai trong ba điểm mở đã đóng nhờ nguồn B; còn một điểm không đạt.")+
     EV("[MOCK] “Điều khoản minh họa làm căn cứ cho điểm 4, trích để Huynh đối chiếu.”","Căn cứ · [MOCK] điều 5")+
     P("[MOCK] Chưa có điểm nào chờ Huynh quyết ở lượt này."))}
`,"DUNG_BINH,BINH_LUC,BINH_KHI,HOI_BAO,CHIEN_BAO")}

  <span class="mock-tag" style="margin-top:28px">MOCK · hội thoại giả lập · Entry đọc RUNTIME.state=${RUNTIME.state}, scope=${RUNTIME.scope}</span>
</div></section>`:"";
document.getElementById("cs").classList.toggle("has-work",MOCK);
document.getElementById("cs").innerHTML=`
<div class="cb" id="cb" aria-label="Ngữ cảnh làm việc">
  <div class="cb-in">
    <nav class="cb-rail" aria-label="Chín mục">${RAIL.map(([id,f,n])=>`<button type="button" class="m${id===STATE.status?" st":""}" data-sem="${id}"><img class="mi" style="--ms:${MINI_SCALE[f]||1}" src="${MINI_DIR}mini-${f}.webp" alt="" data-fb="${CCL_A}icon-${f}.webp" onerror="this.onerror=null;this.src=this.dataset.fb"><span>${n}</span></button>`).join("")}</nav>
    <button class="cb-open" id="cbOpen" aria-expanded="false" aria-controls="cbPop" aria-label="Mở rail"><svg viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3"/></svg></button>
  </div>
  <div class="cb-pop" id="cbPop" hidden>
    <div class="row r1">${RAIL.slice(0,5).map(item).join("")}</div>
    <div class="row r2">${RAIL.slice(5).map(item).join("")}</div>
  </div>
</div>
<div class="entry" id="entry">
<section class="hero" data-tier="1">
  <div class="chip"><i></i>${esc(STATE.hero.status)}</div>
  <div class="lock">
    <div class="kicker">${esc(STATE.hero.kicker)}</div>
    <div class="motto">${esc(STATE.hero.motto)}</div>
    <h1 class="title">${esc(STATE.hero.title)}</h1>
    <p class="lead">${esc(STATE.hero.lead)}</p>
  </div>
</section>
<div class="sheet" data-tier="content">
  <nav class="rail" data-tier="2" aria-label="Chín mục">
    <div class="row r1">${RAIL.slice(0,5).map(item).join("")}</div>
    <div class="row r2">${RAIL.slice(5).map(item).join("")}</div>
  </nav>
  <div class="div" aria-hidden="true"><i></i></div>
  <section class="body" data-tier="3">
    <div class="txt"><div class="sec-k">${esc(STATE.soai.kicker)}</div>
    <h2 class="sec-h">${esc(STATE.soai.point)}</h2>
    <p class="sec-t">${esc(STATE.soai.text)}</p></div>
    <div class="cta" data-sl="1"><div><b>${esc(STATE.soai.cta)}</b><span>${esc(STATE.soai.sub)}</span></div>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></div>
  </section>
</div>
</div>${WORK}`;
/* LIVE/NORMAL connector blocks removed from public bundle (dead in FULL MODE; contained business IDs). Data arrives via window.CCL_DATA. */
if(PROTO&&!ENTRY_MOCK)document.documentElement.dataset.entry="wait";
/* ===== BEHAVIOR CONTROLLER · candidate v0.3 — UI KHÔNG giữ state riêng; authority kiểm lúc append =====
   Mở trang: đọc event log từ kho → kiểm toàn vẹn → replay → vẽ. Mỗi thao tác: ghi event xuống kho TRƯỚC, ghi xong mới đổi state + vẽ lại.
   Bền thật: event log trong IndexedDB của trình duyệt này. Còn MOCK: Identity Provider (phiên không mật khẩu), sổ grant, runtime, verifier.
   Front-stage chỉ hiện một dòng ngắn khi bị chặn; chi tiết authority chỉ ở bảng nhật ký kiểm (?log=1). */
if(PROTO){(function(){
  const WORK_ID=(window.CCL_DATA&&window.CCL_DATA.work_id)||"W-TCTL-PROTO-002";   /* work item giả lập — work item thật sẽ đến từ Mạch Việc */
  const FLOW={
    sl:{name:"Soái Lệnh",cta:"Truyền lệnh",fork:"Ra lệnh lại",tag:"Triển",
        q:"[MOCK] Lệnh tiếp theo cho mạch rà soát",
        lbl:"Việc cần hạ lệnh",d3:"Đã truyền",d4:"Đã thi hành",db:"Truyền lệnh bị chặn",
        brief:"[MOCK] Hai nguồn mâu thuẫn về hiệu lực (A: bản 2023; B: bản điều chỉnh chưa rõ ngày). Mạch rà soát dừng ở điểm 4, cần Huynh hạ lệnh hướng đi.",
        rec:"Nghiêng Hướng 1: chốt hiệu lực nguồn B trước để khỏi làm lại.",
        recIdx:0,
        opts:[{n:"[MOCK] Hướng 1 — xin xác nhận hiệu lực nguồn B trước",d:"Chậm khoảng 1–2 ngày, kết luận chắc."},
              {n:"[MOCK] Hướng 2 — kết luận tạm theo nguồn A",d:"Nhanh, nhưng có thể phải sửa lại."},
              {n:"[MOCK] Hướng 3 — dừng, chờ thêm hồ sơ",d:"Mạch đứng yên tới khi có hồ sơ."}]},
    qd:{name:"Quyết Định",cta:"Ấn phê",fork:"Đổi quyết định",tag:"Quất",
        q:"[MOCK] Phê duyệt phương án xử lý điểm 4",
        lbl:"Nội dung trình phê",d3:"Đã ấn phê",d4:"Đã phê",db:"Ấn phê bị chặn",
        brief:"[MOCK] Điểm 4 thiếu mặt bằng tầng hầm đúng revision. Hai cách xử lý kéo theo hệ quả khác nhau cho mốc phản hồi; cần Huynh phê một phương án.",
        rec:"Nghiêng Phương án B: giữ mốc phản hồi, vẫn có điều kiện ràng buộc.",
        recIdx:1,
        opts:[{n:"[MOCK] Phương án A — yêu cầu bổ sung hồ sơ",d:"Mốc phản hồi lùi, hồ sơ đầy đủ."},
              {n:"[MOCK] Phương án B — chấp thuận có điều kiện",d:"Giữ mốc, điều kiện ghi vào ý kiến."}]}};
  (function(D){if(D)for(const k in D)FLOW[k]=Object.assign({},FLOW[k],D[k]);})(window.CCL_DATA&&window.CCL_DATA.flow);
  const _LIVE=!!(window.CCL_DATA&&window.CCL_DATA.live);
  const LBL={1:"Chờ chọn",2:"Đã chọn · còn đổi được",3:"Đang thi hành",4:"Hoàn tất"};
  const SE={none:"chưa có tác động",partial:"đã tác động một phần",unknown:"không rõ đã tác động tới đâu"};
  /* NGUỒN AUTHORITY — MOCK. Nguồn thật (identity + phân quyền) chưa commissioning. */
  /* IDENTITY + AUTHORITY — MOCK. Nguồn thật (SSO / phân quyền tổ chức) chưa commissioning. */
  const ACTORS=[["U-HUYNH","human","Huynh"],["AI-LUONG-CLAUDE","ai","Lượng"],["SYS-RUNTIME-MOCK","system","Runtime (mock)"],["V-MOCK-01","human","Verifier (mock)"],["U-DELEGATE-01","human","Ủy nhiệm (mock)"]];
  const IDP=CCL_AUTH.createIdentityProvider(ACTORS.map(([a,k,d])=>({actor_id:a,kind:k,display:d,status:"ACTIVE"})));
  const PR=["SELECT","COMMAND","APPROVE","RETRY","REVOKE","FORK","DISCARD"];
  const AUTHZ=CCL_AUTH.createAuthority({idp:IDP,grants:[
    {grant_id:"AG-HUYNH-PRINCIPAL",actor_id:"U-HUYNH",role:"PRINCIPAL",work_id:WORK_ID,scope:{flows:["sl","qd"]},authority_types:PR,source_ref:"SRC-MOCK-OWNER-ASSIGNMENT"},
    {grant_id:"AG-LUONG-ADVISOR",actor_id:"AI-LUONG-CLAUDE",role:"ADVISOR",work_id:WORK_ID,authority_types:["PROPOSE","RECOMMEND"],source_ref:"SRC-MOCK-ROLE-ASSIGNMENT"},
    {grant_id:"AG-RUNTIME",actor_id:"SYS-RUNTIME-MOCK",role:"RUNTIME",work_id:WORK_ID,authority_types:["REPORT_EXECUTION"],source_ref:"SRC-MOCK-SYSTEM"},
    {grant_id:"AG-VERIFIER-01",actor_id:"V-MOCK-01",role:"VERIFIER",work_id:WORK_ID,authority_types:["VERIFY"],source_ref:"SRC-MOCK-QA-ASSIGNMENT"},
    {grant_id:"AG-DEL-LIMITED",actor_id:"U-DELEGATE-01",role:"DELEGATE",work_id:WORK_ID,authority_types:["SELECT","COMMAND","APPROVE"],source_ref:"SRC-MOCK-DELEGATION",
     delegation:{from_grant:"AG-HUYNH-PRINCIPAL",level:"LIMITED",limits:{types:["SELECT","COMMAND"],flows:["sl"]}}}]});
  const CRED={};ACTORS.forEach(([a])=>CRED[a]=IDP.login(a));   /* credential giữ kín trong closure — nhãn actor trên event KHÔNG đủ */
  const TEST=!!_q.get("test");
  if(TEST&&_q.get("revoke"))_q.get("revoke").split(",").forEach(g=>AUTHZ.revoke(g));
  const ACTN={SELECT:"chọn phương án",COMMAND:"truyền lệnh",APPROVE:"ấn phê",REVOKE:"thu hồi / quay về chọn",RETRY:"thử lại",FORK:"mở thẻ thay thế",DISCARD:"bỏ thẻ",VERIFY:"kiểm chứng",REPORT_EXECUTION:"báo kết quả",PROPOSE:"tạo thẻ",RECOMMEND:"kiến nghị"};
  const MSG={};   /* thông báo ngắn theo thẻ — chỉ hiển thị, không phải state */
  const blockText=r=>r.hold?"Đang chờ: quyền hiện có chưa đủ cho việc này — cần người có quyền gốc xác nhận.":
    (r.auth&&r.auth.decision&&r.auth.decision!=="ALLOW")?"Không thực hiện: chưa có quyền "+(ACTN[r.auth.authority_type]||"")+" cho việc này.":
    r.gate?"Không thực hiện: thao tác chưa được xác nhận.":"Không thực hiện: "+r.reason;
  const rnd=()=>{try{const a=new Uint32Array(2);crypto.getRandomValues(a);return a[0].toString(36)+a[1].toString(36).slice(0,3);}catch(e){return Math.random().toString(36).slice(2,10);}};
  const idGen=p=>p+"-"+Date.now().toString(36)+"-"+rnd();
  /* Mã thao tác: chỉ cấp khi click THẬT (isTrusted), dùng 1 lần, giữ kín trong closure */
  const ISSUED=new Set();
  const gestureGate=e=>{if(e.type!=="COMMIT")return null;const g=e.payload&&e.payload.proof;if(!g||!ISSUED.has(g.id))return "Mã thao tác không do click thật cấp, hoặc đã dùng";ISSUED.delete(g.id);return null;};
  const proofOf=e=>{const t=!!(e&&e.isTrusted);const id="G-"+rnd();if(t)ISSUED.add(id);return{via:"ui",trusted:t,id};};
  let M=null,store=null,notice="";
  const sendAs=(actor,ev,cred)=>M.send(Object.assign({},ev,{actor,credential:cred===undefined?CRED[actor]:cred}));
  const bc=(()=>{try{return new BroadcastChannel("ccl_behavior");}catch(e){return null;}})();
  const get=id=>M?M.card(id):null;
  const list=f=>{if(!M)return[];const m=M.model();return m.order.map(id=>m.cards[id]).filter(c=>c.flow===f&&!c.discarded);};
  function html(c){
    const F=FLOW[c.flow],lockAll=c.state>=3||c.flag==="sup";
    const sb=c.supById?get(c.supById):null;
    const fl=(c.flag==="blk"?`<span class="bc-fl blk">Bị chặn / lỗi</span>`:"")+(c.flag==="sup"?`<span class="bc-fl sup">Đã thay thế${c.supBy?" bởi #"+c.supBy:""}${sb&&sb.flag==="blk"?" · #"+sb.n+" đang bị chặn":""}</span>`:"")+(c.verified?`<span class="bc-fl ver">Đã kiểm chứng${c.verification&&c.verification.mock?" · MOCK":""}</span>`:"");
    const act=c.state===3&&!c.flag?`<span class="bc-act" aria-hidden="true"><b></b><b></b><b></b></span>`:"";
    const old=c.replaces?get(c.replaces):null;
    const dk=c.flag==="blk"?F.db:(c.state>=4?F.d4:F.d3);
    const dec=(c.state>=3&&c.sel!==null)?`<p class="bc-dec"><span class="bc-dk">${dk}</span><b>${F.opts[c.sel].n.replace("[MOCK] ","")}</b></p>`:"";
    let x="";
    if(c.state===2&&!c.flag)x+=`<button class="bc-cta" data-a="commit" type="button">${F.cta}</button>`;
    if(c.state===3&&!c.flag)x+=`<p class="bc-note">${c.attempt>1?"Lần thử "+c.attempt+" — ":""}${F.d3} — đang chờ ${c.flow==="qd"?"ghi nhận":"kết quả"}. Toàn bộ lựa chọn đã khóa.</p>`;
    if(c.flag==="blk"){const canBack=c.lastFail&&c.lastFail.sideEffect==="none";
      x+=`<div class="bc-err">[MOCK] Lần ${c.lastFail.attempt}: không thành, ${SE[c.lastFail.sideEffect]}. Chưa hoàn tất — không tự chuyển sang Hoàn tất.${canBack?"":" Chỉ được thử lại."}</div><div class="bc-row"><button class="bc-sec" data-a="retry" type="button">Thử lại</button><button class="bc-sec" data-a="back" type="button"${canBack?"":" disabled"}>Quay về chọn</button></div>`;}
    if(c.state===4&&!c.flag){const pf=c.pendingFork?get(c.pendingFork):null;
      x+=`<p class="bc-note">Hoàn tất ≠ đã kiểm chứng.</p><div class="bc-row"><button class="bc-sec" data-a="fork" type="button"${pf?" disabled":""}>${pf?"Đang có thẻ thay thế #"+pf.n:F.fork}</button></div>`;}
    if(old&&c.state<3)x+=`<p class="bc-note">Thẻ thay thế cho #${old.n}. Thẻ #${old.n} vẫn hiện hành tới khi ${F.cta.toLowerCase()}.</p><div class="bc-row"><button class="bc-sec" data-a="discard" type="button">Bỏ thẻ mới</button></div>`;
    let t="";
    if(c.state===3&&!c.flag&&!_LIVE)t=`Bảng thử · runtime giả lập <button data-a="ok" type="button">Thành công</button><button data-a="fail-none" type="button">Thất bại · chưa tác động</button><button data-a="fail-unk" type="button">Thất bại · không rõ tác động</button>`;
    if(c.state===4&&!c.flag&&!c.verified&&!_LIVE)t=`Bảng thử · verifier MOCK <button data-a="verify" type="button">Kiểm chứng (có evidence)</button>`;
    return `<article class="bcard st-${c.state}${c.flag?" fl-"+c.flag:""}" data-card="${c.id}" data-flow="${c.flow}" data-state="${c.state}" data-flag="${c.flag||""}" data-verified="${c.verified}" data-domain="${CCL_SM.domainStatus(c)}" data-attempt="${c.attempt}">
      <header class="bc-h"><span class="bc-k">${F.name} · #${c.n}</span><span class="bc-st"><i></i>${c.flag==="blk"?LBL[3]+" · dừng":LBL[c.state]}${act}</span>${fl}</header>
      <div class="bc-b"><div class="bc-ill">${BA(c.flow+"-"+c.state)}${c.verified?`<span class="bc-ver">${BA_CONFIRM(c.verified===true)}</span>`:""}</div>
        <div class="bc-txt"><p class="bc-q">${F.q}</p>${dec}<p class="bc-lbl">${F.lbl}</p><p class="bc-brief">${F.brief}</p>${c.rec!==null?`<p class="bc-rec${c.state>=3?" hist":""}"><span class="bc-rk">Lượng kiến nghị</span> ${F.rec}${c.state<=2?` <em>Kiến nghị chưa phải quyết định.</em>`:""}</p>`:""}</div>
        <div class="bc-opts" role="group" aria-label="Lựa chọn">${F.opts.map((o,i)=>`<button class="bc-o${c.sel===i?" on":""}${i===c.rec?" isrec":""}" data-a="pick" data-i="${i}" type="button" aria-pressed="${c.sel===i}"${lockAll?" disabled":""}><span class="bc-on">${o.n}</span>${i===c.rec?`<span class="bc-tag" title="Lượng khuyến nghị — chưa phải lựa chọn của Huynh">${F.tag}</span>`:""}<span class="bc-od">${o.d}</span></button>`).join("")}</div>
        ${(MSG[c.id]||x)?`<div class="bc-x">${MSG[c.id]?`<div class="bc-err bc-deny">${MSG[c.id]}</div>`:""}${x}</div>`:""}</div>
      ${t?`<div class="bc-test">${t}</div>`:""}</article>`;
  }
  const LOG=true?(()=>{const s=document.createElement("section");s.className="sm-log";s.id="smLog";document.getElementById("cs").appendChild(s);return s;})():null;
  const sn=v=>v?(v.state?("S"+v.state+(v.flag?"·"+v.flag:"")):"S"+v):"–";
  const sh=x=>String(x||"").slice(-6);
  function renderLog(){if(!LOG||!M)return;const L=M.log(),R=M.report()||{},H=M.head();
    const q=(R.quarantined||[]);
    LOG.innerHTML=`<h4>Nhật ký state machine · công cụ kiểm</h4>
      <p class="sm-meta">Kho: <b>${R.store}</b>${R.durable?" (bền trong trình duyệt này)":" (KHÔNG bền — mất khi tải lại)"} · work: ${WORK_ID} · ${L.length} event · head #${H.seq} / ${H.hash}${R.meta_fixed?` · đã đối chiếu meta ${R.meta_fixed.from}→${R.meta_fixed.to}`:""}</p>
      ${q.length?`<p class="sm-q">Phục hồi lúc mở trang: cách ly ${q.length} bản ghi — ${q.map(x=>"#"+x.seq+" "+x.reason).join("; ")}</p>`:`<p class="sm-meta">Phục hồi lúc mở trang: log toàn vẹn, dựng lại bằng replay ${R.events} event.</p>`}
      <ol>${L.map(e=>`<li class="${e.ok?"":"no"}"><b>#${e.seq}</b> ${e.actor} · ${e.type}${e.auth?` <span class="sm-id">[${e.auth.decision}${e.auth.grant_id?" "+e.auth.grant_id+" v"+e.auth.grant_version+" · "+e.auth.role:""} · ${e.auth.authority_type||""} · reg v${e.auth.registry_version||"–"}]</span>`:""} · thẻ …${sh(e.card)} · ${sn(e.from)}→${e.ok?sn(e.to):"✗"}${e.ok?"":" — "+e.reason} <span class="sm-id">${sh(e.event_id)} · ${e.hash}</span></li>`).join("")}</ol>`;}
  function renderNotice(){const el=document.getElementById("smStore");if(el)el.textContent=notice;}
  /* ENTRY ↔ MODEL (candidate): hero / chip / khối Soái Lệnh / chấm trạng thái rail đọc từ model, không còn state giả.
     Ưu tiên: có việc cần Huynh (chờ chọn/ấn phê hoặc BLOCKED) > đang thi hành > có hồi báo chưa kiểm chứng > chờ lệnh.
     Thẻ đã SUPERSEDED / bị bỏ không tính. Dùng đúng 5 text của SYSTEM_STATES đã khóa — không thêm chữ mới. */
  function entryKeyOf(){
    const cs=["sl","qd"].flatMap(f=>list(f)).filter(c=>c.flag!=="sup");
    if(!cs.length)return"IDLE";
    if(cs.some(c=>c.state<=2||c.flag==="blk"))return"DECISION_REQUIRED";
    if(cs.some(c=>c.state===3))return"EXECUTING";
    if(cs.some(c=>c.state===4&&!c.verified))return"REPORT";
    return"IDLE";
  }
  function applyEntry(){
    if(ENTRY_MOCK)return;
    const k=M?entryKeyOf():"IDLE",S=SYSTEM_STATES[k],q=s=>document.querySelector(s);
    RUNTIME.state=k;document.documentElement.dataset.entry=k;
    const chip=q(".hero .chip");if(chip&&chip.lastChild)chip.lastChild.textContent=S.chip;
    const set=(s,t)=>{const e=q(s);if(e)e.textContent=t;};
    set(".hero .title",S.title);set(".hero .lead",S.lead);
    set(".sec-k",S.kicker);set(".sec-h",S.point);set(".sec-t",S.text);set(".cta span",S.sub);
    document.querySelectorAll("#cs .it[data-sem],#cs .cb-rail .m[data-sem]").forEach(e=>e.classList.toggle("st",!!S.status&&e.dataset.sem===S.status));
  }
  function ctaTarget(){
    const cs=["sl","qd"].flatMap(f=>list(f)).filter(c=>c.flag!=="sup");
    const t=cs.find(c=>c.state<=2||c.flag==="blk")||cs.find(c=>c.state===3)||cs.find(c=>c.state===4&&!c.verified)||cs[0];
    return t?document.querySelector('.bcard[data-card="'+t.id+'"]'):document.getElementById("bp-sl");
  }
  /* CTA Soái Lệnh ở entry chỉ ĐIỀU HƯỚNG tới thẻ đang cần xử lý — không tạo event, không phải chọn / phê / truyền lệnh. */
  (function(){const cta=document.querySelector(".cta[data-sl]");if(!cta)return;
    cta.setAttribute("role","button");cta.tabIndex=0;
    const go=()=>{const el=ctaTarget();if(el)el.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"center"});};
    cta.addEventListener("click",go);
    cta.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();go();}});})();
  function render(){["sl","qd"].forEach(f=>{const box=document.getElementById("bp-"+f);if(box)box.innerHTML=list(f).map(html).join("");});renderLog();renderNotice();applyEntry();}
  const ACT={
    pick:(e,i)=>({type:"SELECT",actor:"U-HUYNH",payload:{option:+i}}),
    commit:e=>({type:"COMMIT",actor:"U-HUYNH",payload:{proof:proofOf(e)}}),
    ok:(e,i,c)=>({type:"RUNTIME_OK",actor:"SYS-RUNTIME-MOCK",payload:c&&c.flow==="sl"?{executor:"AI-LUONG-CLAUDE",source:"mock"}:{source:"mock"}}),
    "fail-none":()=>({type:"RUNTIME_FAIL",actor:"SYS-RUNTIME-MOCK",payload:{sideEffect:"none",source:"mock"}}),
    "fail-unk":()=>({type:"RUNTIME_FAIL",actor:"SYS-RUNTIME-MOCK",payload:{sideEffect:"unknown",source:"mock"}}),
    retry:()=>({type:"RETRY",actor:"U-HUYNH"}),
    back:()=>({type:"RECALL",actor:"U-HUYNH"}),
    verify:()=>({type:"VERIFY",actor:"V-MOCK-01",payload:{evidence_ref:"EV-MOCK-"+rnd(),mock:true}}),
    fork:()=>({type:"FORK",actor:"U-HUYNH",payload:{newId:idGen("C")}}),
    discard:()=>({type:"DISCARD",actor:"U-HUYNH"})};
  async function send(ev){
    const r=await sendAs(ev.actor,ev);
    if(r&&r.ok&&!r.duplicate&&ev.type==="COMMIT"&&window.CCL_BRIDGE){const c0=get(ev.card);try{if(c0)window.CCL_BRIDGE.commit(c0.flow,c0.sel,FLOW[c0.flow]);}catch(e){}}
    if(r&&ev.card){if(!r.ok&&r.persisted!==false&&!r.duplicate)MSG[ev.card]=blockText(r);else if(r.ok)delete MSG[ev.card];}
    if(r&&r.persisted===false)notice="Không ghi được xuống kho ("+r.persistError+") — thao tác chưa có hiệu lực, state giữ nguyên.";
    else if(r&&r.ok&&!r.duplicate){
      if(r.type==="FORK"){const nc=get(r.payload.newId);if(nc)await sendAs("AI-LUONG-CLAUDE",{type:"RECOMMEND",card:nc.id,payload:{rec:FLOW[nc.flow].recIdx,source:"mock"}});}}
    if(r&&r.persisted!==false&&!r.duplicate&&bc)try{bc.postMessage({work_id:WORK_ID,seq:M.head().seq});}catch(e){}   /* báo tab khác SAU khi ghi xong cả chuỗi */
    render();return r;
  }
  async function seedIfEmpty(){if(M.log().length)return;for(const f of ["sl","qd"])await sendAs("AI-LUONG-CLAUDE",{type:"CREATE",payload:{id:idGen("C"),flow:f,nOpts:FLOW[f].opts.length,rec:FLOW[f].recIdx}});}
  async function init(){
    try{store=await CCL_IDB.openIdbStore("ccl_behavior_v1");notice="Đã lưu: event log nằm trong trình duyệt này, tải lại trang vẫn giữ.";}
    catch(e){store=CCL_SM.MemoryStore();notice="Trình duyệt này không cho lưu ("+(e.code||e.message)+") — state chỉ còn tới khi tải lại.";}
    M=CCL_SM.createPersistentMachine({store,workId:WORK_ID,idGen,authorize:AUTHZ.authorize,gates:[gestureGate]});
    let rep;
    try{rep=await M.open();}catch(e){notice="Không đọc được event log ("+(e.code||e.message)+").";applyEntry();throw e;}
    if(rep.quarantined.length)notice="Phục hồi: đã cách ly "+rep.quarantined.length+" bản ghi hỏng, state dựng lại từ phần log hợp lệ.";
    await seedIfEmpty();render();
    window.BP.ready=true;
  }
  if(bc)bc.onmessage=m=>{if(M&&m.data&&m.data.work_id===WORK_ID)M.resync().then(render);};
  document.addEventListener("click",e=>{const b=e.target.closest("[data-a]");if(!b||b.disabled||!M)return;const card=b.closest("[data-card]");if(!card||!ACT[b.dataset.a])return;
    const ev=ACT[b.dataset.a](e,b.dataset.i,get(card.dataset.card));ev.card=card.dataset.card;send(ev);});
  document.getElementById("bpReset").addEventListener("click",async()=>{if(!M)return;await M.reset();await seedIfEmpty();notice="Đã đặt lại: xóa event log của work này.";render();});
  window.BP={ready:false,send:ev=>M.send(ev).then(r=>{render();return r;}),model:()=>M.model(),log:()=>M.log(),card:get,head:()=>M.head(),report:()=>M.report(),
    replay:()=>CCL_SM.replay(M.log()),domain:CCL_SM.domainStatus,store:()=>store,idle:()=>M.idle(),reopen:()=>M.resync().then(r=>{render();return r;}),workId:WORK_ID,idGen};
  /* Hook kiểm chỉ có khi ?test=1 — bản publish không có */
  if(TEST)window.BP.test={sendAs:(a,ev,cred)=>sendAs(a,ev,cred).then(r=>{render();return r;}),cred:a=>CRED[a],revoke:g=>AUTHZ.revoke(g),grants:()=>AUTHZ.grants(),regVersion:()=>AUTHZ.version(),revokeSession:a=>IDP.revokeSession(CRED[a].session_id),addGrant:g=>AUTHZ.add(g),ui:(ev)=>send(ev)};
  init();
})();}
/*CCL_CTL:END*/
if(_q.get("ba")){   /* công cụ kiểm slot (?ba=1) — không phải UI thật */
  const lab=document.createElement("section");lab.className="ba-lab";
  lab.innerHTML=`<h4>Behavior asset slots · công cụ kiểm</h4><div class="ba-grid">${Object.entries(BEHAVIOR_ASSETS).map(([k,a])=>`<div class="ba-cell">${BA(k,{size:96})}<b style="font-weight:400;color:var(--sech)">${a.sem}</b><code>${a.file}</code></div>`).join("")}</div>`;
  document.getElementById("cs").appendChild(lab);
}
/* Atmospheric scroll transition (không phải motion nghiệp vụ): title/body chìm dần trong ~110 px đầu */
(function(){
  const lock=document.querySelector('.hero .lock'),lead=lock.querySelector('.lead'),W=70;let raf=0;
  const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
  function upd(){raf=0;const p=clamp((window.scrollY||0)/W,0,1);
    lock.style.opacity=(1-.85*p).toFixed(3);
    lock.style.transform='translateY('+(-10*p).toFixed(2)+'px)';
    lead.style.opacity=(1-.35*p).toFixed(3);}   /* body chìm theo, cộng dồn với lớp ngoài */
  addEventListener('scroll',()=>{if(!raf)raf=requestAnimationFrame(upd)},{passive:true});upd();
})();
/* PHASE A → B: hero nhả khi khối entry hết quãng sticky; compact bar xuất hiện khi rail lớn rời màn hình */
(function(){
  const root=document.documentElement,entry=document.getElementById('entry'),hero=entry.querySelector('.hero'),
        rail=entry.querySelector('.rail'),cb=document.getElementById('cb'),btn=document.getElementById('cbOpen'),pop=document.getElementById('cbPop');
  let raf=0;
  function upd(){raf=0;
    const release=entry.offsetTop+entry.offsetHeight-hero.offsetHeight;      /* scrollY mà hero hết sticky */
    root.dataset.phase=(window.scrollY>=release)?'work':'entry';
    const show=rail.getBoundingClientRect().bottom<barH();
    if(show&&!cb.classList.contains('show')){const cr=cb.querySelector('.cb-rail'),on=cr.querySelector('.m.on');if(on)cr.scrollLeft=on.offsetLeft-(cr.clientWidth-on.offsetWidth)/2;}   /* mục active tự vào vùng nhìn thấy */
    cb.classList.toggle('show',show);spy();
    if(!show&&!pop.hidden){pop.hidden=true;btn.setAttribute('aria-expanded','false');}}
  /* ===== TAP → SECTION · SCROLL SPY (prototype UI, chưa nối state machine) ===== */
  const barH=()=>cb.querySelector('.cb-in').getBoundingClientRect().height,GAP=10;
  const scopeEl=()=>document.querySelector('.turn.luong[data-resp="'+RUNTIME.scope+'"]');
  const secOf=id=>{const sc=scopeEl();return sc?sc.querySelector('.ssec[data-sem="'+id+'"]'):null;};   /* chỉ tìm TRONG response hiện hành */
  const secsOfScope=()=>{const sc=scopeEl();return sc?[...sc.querySelectorAll('.ssec[data-sem]')]:[];};
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let navTarget=null,anim=0;   /* mục vừa tap giữ active cho tới khi user tự cuộn */
  function setActive(id){
    cb.querySelectorAll('.cb-rail .m').forEach(m=>m.classList.toggle('on',m.dataset.sem===id));
    cb.querySelectorAll('.cb-pop .it').forEach(m=>{const on=m.dataset.sem===id;m.classList.toggle('on',on);on?m.setAttribute('aria-current','true'):m.removeAttribute('aria-current')});
  }
  function refreshScope(){
    document.querySelectorAll('.turn.luong[data-resp]').forEach(a=>a.dataset.scope=(a.dataset.resp===RUNTIME.scope)?'active':'past');
    cb.querySelectorAll('[data-sem]').forEach(el=>{const has=!!secOf(el.dataset.sem);
      el.classList.toggle('off',!has);has?(el.removeAttribute('aria-disabled'),el.removeAttribute('title')):(el.setAttribute('aria-disabled','true'),el.title='Response hiện hành không có mục này');});
  }
  window.CCL_setScope=function(r){RUNTIME.scope=r;navTarget=null;refreshScope();setActive(null);spy();};   /* chỉ logic ngữ cảnh gọi, không do cuộn */
  refreshScope();
  function goTo(id){
    const sec=secOf(id);if(!sec)return;
    if(sec.tagName==='DETAILS')sec.open=true;                         /* section dạng accordion đang collapse → mở */
    setActive(id);navTarget=id;
    const y0=scrollY,y1=Math.max(0,Math.round(sec.getBoundingClientRect().top+scrollY-barH()-GAP)),D=reduce?0:220,t0=performance.now();
    cancelAnimationFrame(anim);
    if(!D){scrollTo(0,y1);return}
    (function step(t){const k=Math.min(1,(t-t0)/D),e=1-Math.pow(1-k,3);          /* easeOutCubic: không overshoot */
      scrollTo(0,y0+(y1-y0)*e);if(k<1)anim=requestAnimationFrame(step);})(performance.now());
  }
  cb.addEventListener('click',e=>{const el=e.target.closest('.m[data-sem],.it[data-sem]');if(!el||el.classList.contains('off'))return;
    goTo(el.dataset.sem);if(!pop.hidden){pop.hidden=true;btn.setAttribute('aria-expanded','false');}});
  ['wheel','touchstart','keydown','mousedown'].forEach(ev=>addEventListener(ev,()=>{cancelAnimationFrame(anim);navTarget=null;},{passive:true}));
  function spy(){
    if(navTarget||root.dataset.phase!=='work')return;
    const secs=secsOfScope();if(!secs.length)return;                  /* scope = response hiện hành, không quét cả lịch sử */
    const line=barH()+(innerHeight-barH())*.3;let cur=null;
    for(const s2 of secs){if(s2.getBoundingClientRect().top<=line)cur=s2;else break;}
    const last=[...document.querySelectorAll('.turn.luong[data-resp]')].pop();
    if(last&&last.dataset.resp===RUNTIME.scope&&innerHeight+scrollY>=document.documentElement.scrollHeight-2)cur=secs[secs.length-1];
    setActive(cur?cur.dataset.sem:null);                              /* chưa tới response hiện hành → không sáng mục nào */
  }
  btn.addEventListener('click',()=>{const o=pop.hidden;pop.hidden=!o;btn.setAttribute('aria-expanded',String(o));});
  addEventListener('scroll',()=>{if(!raf)raf=requestAnimationFrame(upd)},{passive:true});addEventListener('resize',upd);upd();
})();


/* DEV-only ?vw: đo viewport thật (chẩn đoán, không chạm NORMAL) */
(function(){if(!/[?&]vw\b/.test(location.search))return;
var d=document.createElement("div");d.style.cssText="position:fixed;left:0;bottom:0;z-index:99999;background:#000;color:#0f0;font:11px/1.3 monospace;padding:4px 6px;max-width:100%";
function u(){var r=document.querySelector(".rail"),rr=r&&r.getBoundingClientRect(),v=window.visualViewport;
d.textContent="iw="+innerWidth+" cw="+document.documentElement.clientWidth+" sw="+document.documentElement.scrollWidth+" vv="+(v?Math.round(v.width)+"@"+v.scale:"-")+" dpr="+devicePixelRatio+" scr="+screen.width+" rail="+(rr?Math.round(rr.left)+"→"+Math.round(rr.right):"-")}
document.body.appendChild(d);u();addEventListener("resize",u);setTimeout(u,800)})();
