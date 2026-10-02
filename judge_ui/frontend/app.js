const kpiRowEl = document.getElementById("kpi-row");
const stackbarEl = document.getElementById("stackbar");
const stackbarLegendEl = document.getElementById("stackbar-legend");
const rulesListEl = document.getElementById("rules-list");
const slowRulesListEl = document.getElementById("slow-rules-list");
const rulesHintEl = document.getElementById("rules-hint");
const rawPatternsEl = document.getElementById("raw-patterns");
const latencyKpisEl = document.getElementById("latency-kpis");
const sessionsHintEl = document.getElementById("sessions-hint");
const sessionsBodyEl = document.getElementById("sessions-body");
const reviewedSessionsBodyEl = document.getElementById("reviewed-sessions-body");
const reviewVerdictFilterEl = document.getElementById("review-verdict-filter");
const reviewSessionSearchEl = document.getElementById("review-session-search");
const reviewedCountEl = document.getElementById("reviewed-count");
const blockedListEl = document.getElementById("blocked-list");
const verdictListEl = document.getElementById("verdict-list");
const resetBlocklistBtn = document.getElementById("reset-blocklist-btn");

const tokenShareBarEl = document.getElementById("token-share-bar");
const tokenShareLegendEl = document.getElementById("token-share-legend");
const tokenComponentsEl = document.getElementById("token-components");
const pathBarEl = document.getElementById("path-bar");
const pathLegendEl = document.getElementById("path-legend");
const pathNoteEl = document.getElementById("path-note");
const timelineEl = document.getElementById("token-timeline");
const timelineLegendEl = document.getElementById("timeline-legend");
const tokenSessionsEl = document.getElementById("token-sessions");

let rulesRendered = false;
let shadowKey = "";
let lastBlockedCount = 0;
let openSessionId = null;
let reviewedSessions = [];

const detailEl = document.getElementById("session-detail");
const detailBodyEl = document.getElementById("detail-body");

function fmtNumber(n) {
  return new Intl.NumberFormat().format(n || 0);
}

function esc(str) {
  return String(str ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Fast-rule checks take well under a millisecond.
function fmtMs(ms) {
  if (ms == null) return "--";
  return ms < 1 ? `${ms.toFixed(3)} ms` : ms < 100 ? `${ms.toFixed(2)} ms` : `${Math.round(ms)} ms`;
}

function kpiTiles(tiles) {
  return tiles
    .map(
      (tile) => `
      <div class="kpi-tile${tile.status ? ` status-${tile.status}` : ""}">
        <div class="kpi-label">${tile.label}</div>
        <div class="kpi-value">${tile.value}</div>
        ${tile.sub ? `<div class="kpi-sub">${tile.sub}</div>` : ""}
      </div>`
    )
    .join("");
}

function renderLatency(data) {
  const l = data.fast_latency;
  if (!l.checks) {
    latencyKpisEl.innerHTML = '<div class="empty">No requests checked yet</div>';
    return;
  }
  latencyKpisEl.innerHTML = kpiTiles([
    { label: "Average", value: fmtMs(l.avg_ms), sub: `${fmtNumber(l.checks)} checks` },
    { label: "Median", value: fmtMs(l.p50_ms), sub: `last ${l.sample_size}` },
    { label: "95th percentile", value: fmtMs(l.p95_ms), sub: `last ${l.sample_size}` },
    { label: "Slowest", value: fmtMs(l.max_ms), sub: "since first check" },
  ]);
}

function renderSessions(data) {
  const threshold = data.slow_review_threshold;
  sessionsHintEl.textContent =
    `Each fast-rule hit adds to a session's score (minor +1, major +5); a block rule stops the session outright. ` +
    `When a session's score has climbed ${threshold} since its last review, the LLM reviews the whole session.`;
  if (data.sessions.length === 0) {
    sessionsBodyEl.innerHTML = '<tr><td colspan="6" class="empty">No sessions yet</td></tr>';
    return;
  }
  sessionsBodyEl.innerHTML = data.sessions
    .map((s) => {
      const pending = s.score - s.reviewed_score;
      const pct = Math.min(100, (pending / threshold) * 100);
      const status = s.blocked
        ? '<span class="tag bad">blocked</span>'
        : pending >= threshold
        ? '<span class="tag suspicious">review due</span>'
        : '<span class="tag safe">active</span>';
      const r = s.last_review;
      const review = r
        ? `<span class="tag ${["safe", "suspicious", "bad"].includes(r.verdict) ? r.verdict : "suspicious"}">${esc(r.verdict)}</span> <span class="muted" title="${esc(r.reason)}">at score ${r.score_at_review}</span>`
        : '<span class="muted">&mdash;</span>';
      return `
        <tr class="clickable${s.session_id === openSessionId ? " selected" : ""}" data-sid="${esc(s.session_id)}">
          <td title="${esc(s.session_id)}"><code>${esc(s.session_id.slice(0, 8))}</code></td>
          <td>
            <div class="score-cell"><div class="score-track"><div class="score-fill${pending >= threshold ? " hot" : ""}" style="width:${pct}%"></div></div>
            <span>${s.score}</span></div>
          </td>
          <td>${status}</td>
          <td class="muted">${s.recent_hits.length ? esc(s.recent_hits.join(", ")) : "&mdash;"}</td>
          <td>${review}</td>
          <td class="muted">${fmtMs(s.fast_latency_avg_ms)} / ${fmtMs(s.fast_latency_max_ms)}</td>
        </tr>`;
    })
    .join("");
}

function renderReviewedSessions(data) {
  if (data) reviewedSessions = data.reviewed_sessions || [];
  const filter = reviewVerdictFilterEl.value;
  const search = reviewSessionSearchEl.value.trim().toLowerCase();
  const matches = reviewedSessions.filter((session) => {
    const verdict = session.last_review.verdict;
    const verdictMatches = filter === "all" || (filter === "other"
      ? !["safe", "bad", "suspicious"].includes(verdict)
      : verdict === filter);
    return verdictMatches && session.session_id.toLowerCase().includes(search);
  });
  reviewedCountEl.textContent = `${fmtNumber(matches.length)} of ${fmtNumber(reviewedSessions.length)} reviewed sessions`;
  if (!matches.length) {
    reviewedSessionsBodyEl.innerHTML = `<tr><td colspan="6" class="empty">${reviewedSessions.length
      ? "No sessions match this verdict and session ID"
      : "No sessions sent to the judge yet"}</td></tr>`;
    return;
  }
  reviewedSessionsBodyEl.innerHTML = matches.map((session) => {
    const review = session.last_review;
    const time = review.ts ? new Date(review.ts * 1000).toLocaleString() : "--";
    return `<tr class="clickable${session.session_id === openSessionId ? " selected" : ""}" data-sid="${esc(session.session_id)}">
      <td><button type="button" class="session-link" title="${esc(session.session_id)}" aria-label="Open session ${esc(session.session_id)}"><code>${esc(session.session_id.slice(0, 8))}</code></button></td>
      <td><span class="tag ${verdictClass(review.verdict)}">${esc(review.verdict || "unknown")}</span></td>
      <td class="review-reason">${esc(review.reason || "--")}</td>
      <td>${fmtNumber(review.score_at_review)} / ${fmtNumber(session.score)}</td>
      <td><span class="tag ${session.blocked ? "bad" : "safe"}">${session.blocked ? "blocked" : "active"}</span></td>
      <td class="muted">${esc(time)}</td>
    </tr>`;
  }).join("");
}

function renderKpis(data) {
  const t = data.totals;
  const tiles = [
    { label: "Total Requests", value: fmtNumber(t.total_requests) },
    {
      label: `Requests / sec (last ${data.window_seconds}s)`,
      value: data.requests_per_second.toFixed(3),
      sub: `${fmtNumber(data.requests_last_window)} in the window`,
    },
    { label: "Unique Sessions", value: fmtNumber(t.unique_sessions) },
    {
      label: "Blocked Sessions",
      value: fmtNumber(t.blocked_sessions),
      status: t.blocked_sessions > 0 ? "bad" : "safe",
    },
    {
      label: "Total Tokens",
      value: fmtNumber(t.total_tokens),
      sub: `${fmtNumber(t.total_prompt_tokens)} prompt / ${fmtNumber(t.total_completion_tokens)} completion`,
    },
    {
      label: "Fast-rule Latency (avg)",
      value: fmtMs(data.fast_latency.avg_ms),
      sub: `p95 ${fmtMs(data.fast_latency.p95_ms)} · ${fmtNumber(data.fast_latency.checks)} checks`,
    },
    {
      label: "Judge Overhead Tokens",
      value: fmtNumber(t.judge_overhead_tokens),
      sub: `${fmtNumber(t.judge_prompt_tokens)} prompt / ${fmtNumber(t.judge_completion_tokens)} completion`,
    },
  ];

  kpiRowEl.innerHTML = kpiTiles(tiles);
}

function renderStackbar(data) {
  const counts = data.totals.verdict_counts;
  const total = (counts.safe || 0) + (counts.suspicious || 0) + (counts.bad || 0);

  if (total === 0) {
    stackbarEl.innerHTML = "";
    stackbarLegendEl.innerHTML = '<li class="empty">No requests judged yet</li>';
    return;
  }

  const order = ["safe", "suspicious", "bad"];
  stackbarEl.innerHTML = order
    .map((k) => {
      const pct = ((counts[k] || 0) / total) * 100;
      return pct > 0 ? `<div class="seg ${k}" style="width:${pct}%" title="${k}: ${counts[k]}"></div>` : "";
    })
    .join("");

  stackbarLegendEl.innerHTML = order
    .map((k) => {
      const pct = (((counts[k] || 0) / total) * 100).toFixed(1);
      return `<li><span class="swatch ${k}"></span>${k} <span class="count">${counts[k] || 0} (${pct}%)</span></li>`;
    })
    .join("");
}

function segBar(barEl, legendEl, items, emptyMsg) {
  const total = items.reduce((a, i) => a + i.value, 0);
  if (total === 0) {
    barEl.innerHTML = "";
    legendEl.innerHTML = `<li class="empty">${emptyMsg}</li>`;
    return;
  }
  barEl.innerHTML = items
    .filter((i) => i.value > 0)
    .map((i) => `<div class="seg ${i.cls}" style="width:${(i.value / total) * 100}%" title="${i.label}: ${fmtNumber(i.value)}"></div>`)
    .join("");
  legendEl.innerHTML = items
    .map((i) => `<li><span class="swatch ${i.cls}"></span>${i.label} <span class="count">${fmtNumber(i.value)} (${((i.value / total) * 100).toFixed(1)}%)</span></li>`)
    .join("");
}

// rows = [{label, title, value, parts: [{value, cls, light}]}]
function renderHBars(el, rows, emptyMsg) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (max === 0) {
    el.innerHTML = `<div class="empty">${emptyMsg}</div>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (r) => `
      <div class="hbar-row" title="${r.title || r.label}">
        <div class="hbar-label">${r.label}</div>
        <div class="hbar-track">${r.parts
          .filter((p) => p.value > 0)
          .map((p) => `<div class="hbar-fill ${p.cls}${p.light ? " light" : ""}" style="width:${(p.value / max) * 100}%"></div>`)
          .join("")}</div>
        <div class="hbar-value">${fmtNumber(r.value)}</div>
      </div>`
    )
    .join("");
}

function renderTimeline(data) {
  const pts = data.token_timeline;
  const W = 720, H = 180, L = 44, R = 8, T = 8, B = 22;
  const max = Math.max(1, ...pts.map((p) => p.chat + p.judge));
  const mag = Math.pow(10, Math.floor(Math.log10(max)));
  const niceMax = mag * Math.ceil(max / mag);
  const plotH = H - T - B;
  const bw = (W - L - R) / pts.length;
  const y = (v) => T + plotH * (1 - v / niceMax);

  let svg = "";
  for (const f of [0, 0.5, 1]) {
    const v = niceMax * f;
    svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${fmtNumber(Math.round(v))}</text>`;
  }
  pts.forEach((p, i) => {
    const x = L + i * bw;
    const w = Math.max(1, bw - 3);
    const time = new Date(p.t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const chatH = plotH * (p.chat / niceMax);
    const judgeH = plotH * (p.judge / niceMax);
    const base = H - B;
    if (p.chat > 0) svg += `<rect class="chat" x="${x}" y="${base - chatH}" width="${w}" height="${chatH}"/>`;
    if (p.judge > 0) svg += `<rect class="judge" x="${x}" y="${base - chatH - judgeH - (p.chat > 0 ? 2 : 0)}" width="${w}" height="${judgeH}"/>`;
    svg += `<rect class="hit" x="${x}" y="${T}" width="${bw}" height="${plotH}"><title>${time} — chat ${fmtNumber(p.chat)}, judge ${fmtNumber(p.judge)} tokens</title></rect>`;
    if (i % 6 === 0 || i === pts.length - 1) svg += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${time}</text>`;
  });
  timelineEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
  timelineEl.innerHTML = svg;
  timelineLegendEl.innerHTML = '<li><span class="swatch chat"></span>Chat</li><li><span class="swatch judge"></span>Judge</li>';
}

function renderTokenFlow(data) {
  const t = data.totals;
  const totalTokens = (t.total_tokens || 0) + (t.judge_overhead_tokens || 0);
  const percentage = (value, total) => `${(total ? ((value || 0) / total) * 100 : 0).toFixed(1)}%`;
  const values = {
    "flow-input-tokens": fmtNumber(t.total_prompt_tokens),
    "flow-output-tokens": fmtNumber(t.total_completion_tokens),
    "flow-input-token-share": `${percentage(t.total_prompt_tokens, totalTokens)} of total tokens`,
    "flow-output-token-share": `${percentage(t.total_completion_tokens, totalTokens)} of total tokens`,
    "flow-judge-token-share": `${percentage(t.judge_overhead_tokens, totalTokens)} of total tokens`,
    "flow-judge-call-share": percentage(t.judge_calls, t.total_requests),
    "flow-input-sessions": fmtNumber(t.unique_sessions),
    "flow-platform-sessions": fmtNumber(t.unique_sessions),
    "flow-output-sessions": fmtNumber(t.unique_sessions),
    "flow-platform-requests": `${fmtNumber(t.total_requests)} requests`,
    "flow-judge-tokens": fmtNumber(t.judge_overhead_tokens),
    "flow-judge-input": fmtNumber(t.judge_prompt_tokens),
    "flow-judge-output": fmtNumber(t.judge_completion_tokens),
    "flow-judge-calls": fmtNumber(t.judge_calls),
  };
  for (const [id, value] of Object.entries(values)) {
    document.getElementById(id).textContent = value;
  }
}

function renderTokens(data) {
  const t = data.totals;
  renderTokenFlow(data);
  segBar(
    tokenShareBarEl,
    tokenShareLegendEl,
    [
      { label: "Chat", cls: "chat", value: t.total_tokens },
      { label: "Judge", cls: "judge", value: t.judge_overhead_tokens },
    ],
    "No tokens used yet"
  );

  renderHBars(
    tokenComponentsEl,
    [
      { label: "Chat — prompt", value: t.total_prompt_tokens, parts: [{ value: t.total_prompt_tokens, cls: "chat" }] },
      { label: "Chat — completion", value: t.total_completion_tokens, parts: [{ value: t.total_completion_tokens, cls: "chat", light: true }] },
      { label: "Judge — prompt", value: t.judge_prompt_tokens, parts: [{ value: t.judge_prompt_tokens, cls: "judge" }] },
      { label: "Judge — completion", value: t.judge_completion_tokens, parts: [{ value: t.judge_completion_tokens, cls: "judge", light: true }] },
    ],
    "No tokens used yet"
  );

  const p = data.judge_paths;
  segBar(
    pathBarEl,
    pathLegendEl,
    [
      { label: "Blocked by fast rule (0 tokens)", cls: "nino", value: p.fast_block || 0 },
      { label: "Fast rules only (0 tokens)", cls: "rule", value: p.fast || 0 },
      { label: "Slow LLM review", cls: "llm", value: p.slow || 0 },
    ],
    "No requests judged yet"
  );
  const avg = t.judge_calls ? Math.round(t.judge_overhead_tokens / t.judge_calls) : 0;
  const ratio = t.total_tokens ? ((t.judge_overhead_tokens / t.total_tokens) * 100).toFixed(1) : "0.0";
  pathNoteEl.textContent = t.judge_calls
    ? `${fmtNumber(t.judge_calls)} slow reviews averaging ${fmtNumber(avg)} tokens each. Judge overhead is ${ratio}% of chat tokens.`
    : "No slow LLM reviews yet — every exchange was resolved by the deterministic fast rules.";

  renderTimeline(data);

  renderHBars(
    tokenSessionsEl,
    data.top_sessions.map((s) => ({
      label: s.session_id.slice(0, 8),
      title: `${s.session_id} — chat ${fmtNumber(s.chat)}, judge ${fmtNumber(s.judge)} tokens over ${s.requests} requests`,
      value: s.chat + s.judge,
      parts: [
        { value: s.chat, cls: "chat" },
        { value: s.judge, cls: "judge" },
      ],
    })),
    "No sessions yet"
  );
}

function ruleAction(r) {
  return r.action === "block" ? "block" : `+${r.points}`;
}

function shadowChip(r, data) {
  if (!r.shadow) return "";
  const n = (data.shadow_hits || {})[r.id] || 0;
  return ` <span class="action-chip shadow" title="Shadow rule: recorded but not enforced">shadow &middot; ${n} recent hit${n === 1 ? "" : "s"}</span>`;
}

function renderRulesOnce(data) {
  // Static apart from the shadow hit counters, so re-render only when those change.
  const key = JSON.stringify(data.shadow_hits || {});
  if (rulesRendered && key === shadowKey) return;
  rulesRendered = true;
  shadowKey = key;

  const slow = data.slow_review;
  rulesHintEl.textContent =
    `Every fast rule that matches counts: a block rule blocks the session, score rules add points. ` +
    `Slow review runs when a session's score has climbed ${slow.threshold} since its last review.`;

  rulesListEl.innerHTML = data.fast_rules
    .map(
      (r) => `
      <li>
        <div class="rule-head">
          <span class="rule-name">${esc(r.name)}</span>
          <span class="rule-mode"><span class="action-chip ${r.action}">${ruleAction(r)}</span>${shadowChip(r, data)} ${esc(r.scope)}</span>
        </div>
        <div class="rule-desc">${esc(r.description)}</div>
      </li>`
    )
    .join("");

  slowRulesListEl.innerHTML = `
    <li>
      <div class="rule-head">
        <span class="rule-name">${esc(slow.name)}</span>
        <span class="rule-mode">score &ge; ${slow.threshold} since last review</span>
      </div>
      <div class="rule-desc">${esc(slow.description)}</div>
    </li>`;

  rawPatternsEl.innerHTML = data.fast_rules
    .map((r) => `<h3>${esc(r.name)}${r.validator ? ` <span class="muted">(+ ${esc(r.validator)} check)</span>` : ""}</h3><code>${esc(r.pattern)}</code>`)
    .join("");
}

function renderBlocked(data) {
  lastBlockedCount = data.blocked_users.length;
  resetBlocklistBtn.disabled = lastBlockedCount === 0;

  if (lastBlockedCount === 0) {
    blockedListEl.innerHTML = '<li class="empty">None yet</li>';
    return;
  }
  blockedListEl.innerHTML = data.blocked_users
    .map((id) => `<li title="${id}">${id.slice(0, 8)}</li>`)
    .join("");
}

resetBlocklistBtn.addEventListener("click", async () => {
  const count = lastBlockedCount;
  const noun = count === 1 ? "session" : "sessions";
  if (!confirm(`Unblock all ${count} currently blocked ${noun}? They'll be able to send messages again immediately.`)) {
    return;
  }
  resetBlocklistBtn.disabled = true;
  try {
    await fetch("/api/blocklist/reset", { method: "POST" });
  } catch (err) {
    alert(`Failed to reset blocklist: ${err.message}`);
  }
  pollStats();
});

function renderVerdicts(data) {
  if (data.recent_verdicts.length === 0) {
    verdictListEl.innerHTML = '<li class="empty">None yet</li>';
    return;
  }
  verdictListEl.innerHTML = data.recent_verdicts
    .map((v) => {
      const tagClass = ["safe", "suspicious", "bad"].includes(v.verdict) ? v.verdict : "suspicious";
      const time = v.timestamp ? new Date(v.timestamp).toLocaleTimeString() : "";
      return `
        <li class="verdict-item">
          <span class="tag ${tagClass}">${v.verdict || "unknown"}</span>
          <div class="reason">${v.reason || ""}</div>
          <div class="meta">${(v.user_id || "unknown").slice(0, 8)} &middot; ${time} &middot; chat ${fmtNumber(v.chat_tokens)} / judge ${fmtNumber(v.judge_tokens)} tok</div>
        </li>
      `;
    })
    .join("");
}

async function pollStats() {
  try {
    const resp = await fetch("/api/judge-stats");
    const data = await resp.json();
    renderKpis(data);
    renderLatency(data);
    renderSessions(data);
    renderReviewedSessions(data);
    renderStackbar(data);
    renderTokens(data);
    renderRulesOnce(data);
    renderBlocked(data);
    renderVerdicts(data);
  } catch (err) {
    // Backend not reachable yet; ignore and retry on next tick.
  }
}

pollStats();
setInterval(pollStats, 3000);


// --- Session drill-down ---

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString() : "");
const verdictClass = (v) => (["safe", "suspicious", "bad"].includes(v) ? v : "suspicious");

function renderExchange(e) {
  const rules = (e.fast_rules || []).map((r) => `<span class="tag suspicious">${esc(r)}</span>`).join(" ");
  const shadow = (e.shadow_rules || []).map((r) => `<span class="tag shadow">${esc(r)} (shadow)</span>`).join(" ");
  const judge = e.judge
    ? `<details><summary>Judge prompt and raw response</summary>
         <h4>Prompt</h4><pre>${esc(e.judge.prompt || "(not found in judge_activity.log)")}</pre>
         <h4>Raw response</h4><pre>${esc((e.judge.raw || []).join("\n---\n") || "(not found)")}</pre>
       </details>`
    : "";
  return `
    <div class="exchange">
      <div class="exchange-head">
        <span class="muted">${esc(fmtTime(e.timestamp))}</span>
        <span class="tag ${verdictClass(e.verdict)}">${esc(e.verdict)}</span>
        <span class="muted">path: ${esc(e.judge_path || "?")}</span>
        <span class="muted">+${e.points || 0} pts &rarr; score ${e.session_score ?? "?"}</span>
        ${rules} ${shadow}
      </div>
      <div class="exchange-reason">${esc(e.reason || "")}</div>
      <h4>User</h4><pre>${esc(e.user_text || "")}</pre>
      <h4>Assistant</h4><pre>${esc(e.output || "")}</pre>
      <details><summary>Full input sent to the model</summary><pre>${esc(e.input || "")}</pre></details>
      ${judge}
    </div>`;
}

function renderSessionDetail(d) {
  const threshold = d.slow_review_threshold;
  const reviews = (d.reviews || [])
    .map((r) => `<li><span class="tag ${verdictClass(r.verdict)}">${esc(r.verdict)}</span>
      <span class="muted">at score ${r.score_at_review} &middot; ${esc(new Date(r.ts * 1000).toLocaleTimeString())}</span>
      &mdash; ${esc(r.reason || "")}</li>`)
    .join("");
  const trail = d.exchanges.map((e) => e.session_score ?? 0);
  detailBodyEl.innerHTML = `
    <p><code>${esc(d.session_id)}</code>
      ${d.blocked ? '<span class="tag bad">blocked</span>' : '<span class="tag safe">not blocked</span>'}
      <span class="muted">score ${d.score} (reviewed to ${d.reviewed_score}, review at +${threshold}) &middot; ${d.requests} requests</span></p>
    ${trail.length ? `<p class="muted">Score after each exchange: ${trail.join(" &rarr; ")}</p>` : ""}
    <h3>Slow-tier reviews</h3>
    ${reviews ? `<ul class="review-list">${reviews}</ul>` : '<p class="muted">No LLM review has run for this session.</p>'}
    <h3>Exchanges (${d.exchanges.length}, oldest first)</h3>
    ${d.exchanges.map(renderExchange).join("") || '<p class="muted">No logged exchanges (verdict files) for this session.</p>'}`;
}

async function openSession(sid) {
  openSessionId = sid;
  detailEl.hidden = false;
  detailBodyEl.innerHTML = '<p class="muted">Loading&hellip;</p>';
  try {
    const res = await fetch("/api/sessions/" + encodeURIComponent(sid));
    if (!res.ok) throw new Error(res.status === 404 ? "No data for this session." : "HTTP " + res.status);
    renderSessionDetail(await res.json());
  } catch (err) {
    detailBodyEl.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
  detailEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

sessionsBodyEl.addEventListener("click", (ev) => {
  const row = ev.target.closest("tr[data-sid]");
  if (row) openSession(row.dataset.sid);
});
reviewedSessionsBodyEl.addEventListener("click", (ev) => {
  const row = ev.target.closest("tr[data-sid]");
  if (row) openSession(row.dataset.sid);
});
reviewVerdictFilterEl.addEventListener("change", () => renderReviewedSessions());
reviewSessionSearchEl.addEventListener("input", () => renderReviewedSessions());
document.getElementById("detail-refresh").addEventListener("click", () => openSessionId && openSession(openSessionId));
document.getElementById("detail-close").addEventListener("click", () => {
  openSessionId = null;
  detailEl.hidden = true;
});
