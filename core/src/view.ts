// The pipeline view: one read-only local HTML page, <data>/view/index.html, built from the
// stored records and never written to by the page. `regenerateView` is called from one place,
// `withWriter` in store.ts, after the lock is released; it only reads records and replaces two
// files, so it can't recurse or hold the lock. `view` (commands.ts) regenerates and opens it.
// The page loads the vendored Mermaid (core/vendor/mermaid) from a relative path and nothing
// else: no external URL. See core-conventions.md, "Pipeline view".
import { execFile } from "node:child_process";
import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type EventLogEntry, STATUSES, statusLabel } from "./application.ts";
import { nodeId, renderTree } from "./decision-tree.ts";
import { openerCommand, timestamp } from "./env.ts";
import { rankShortlist } from "./screen.ts";
import type { Check } from "./screen-check.ts";
import { listRecords, type StoredRecord, writeThenReplace } from "./store.ts";

export const VIEW_DIR = "view";
export const VIEW_FILE = `${VIEW_DIR}/index.html`;
const MERMAID_FILE = "mermaid.min.js";
const MERMAID_SOURCE = join(import.meta.dirname, "..", "vendor", "mermaid", MERMAID_FILE);

/** The marks the terminal's `why` prints. */
const MARK = { pass: "✓", warn: "!", fail: "✗", not_reached: "·" } as const;
const CLASS = { pass: "ok", warn: "warn", fail: "bad", not_reached: "nr" } as const;

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

interface Screen {
  outcome: "shortlist" | "excluded";
  excluded_by: string | null;
  checks: Check[];
  flags?: { label: string }[];
  badges?: { label: string }[];
  fit?: { score: number; band: string };
}

const screenOf = (l: StoredRecord): Screen | undefined =>
  l.screen && typeof l.screen === "object" ? (l.screen as Screen) : undefined;

const eventsOf = (a?: StoredRecord): EventLogEntry[] =>
  Array.isArray(a?.event_log) ? (a?.event_log as EventLogEntry[]) : [];

/** A button that copies `reply` for pasting into the session. */
function copyButton(reply: string, label = `Copy: ${reply}`, primary = false): string {
  return `<button class="btn${primary ? " primary" : ""}" type="button" data-copy="${esc(reply)}">${esc(label)}</button>`;
}

function fitHtml(fit?: { score: number; band: string }): string {
  return fit ? `<span class="fit ${esc(fit.band)}">Fit ${fit.score} ${esc(fit.band)}</span>` : "";
}

function chips(items: string[]): string {
  return items.map((i) => `<span class="chip">${esc(i)}</span>`).join("");
}

interface Data {
  listings: StoredRecord[];
  apps: StoredRecord[];
  appByListing: Map<string, StoredRecord>;
  shortlist: Awaited<ReturnType<typeof rankShortlist>>;
  failedSources: { company: string; ats: string; message: string }[];
  lastDiscover: string | null;
}

async function load(dataDir: string): Promise<Data> {
  const [listings, apps, runs, shortlist] = await Promise.all([
    listRecords(dataDir, "listing"),
    listRecords(dataDir, "application"),
    listRecords(dataDir, "discover-run"),
    rankShortlist(dataDir),
  ]);
  const appByListing = new Map(
    apps.filter((a) => typeof a.listing === "string").map((a) => [a.listing as string, a]),
  );
  runs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const last = runs.at(-1);
  const sources = (Array.isArray(last?.sources) ? last.sources : []) as {
    company?: string;
    ats?: string;
    id?: string;
    status?: string;
    error?: { code?: string; message?: string } | null;
  }[];
  const failedSources = sources
    .filter((s) => s.status !== "ok")
    .map((s) => ({
      company: String(s.company ?? s.id ?? "unknown"),
      ats: String(s.ats ?? ""),
      message: s.error?.message ?? `${s.status ?? "not read"}`,
    }));
  return {
    listings,
    apps,
    appByListing,
    shortlist,
    failedSources,
    lastDiscover: typeof last?.finished_at === "string" ? last.finished_at : null,
  };
}

// ---------------------------------------------------------------------------------------
// Needs you

const row = (kind: string, body: string, acts: string) =>
  `<div class="todo"><div class="kind">${esc(kind)}</div><div class="body">${body}</div><div class="acts">${acts}</div></div>`;

function needsTab(d: Data): string {
  const out: string[] = [];
  let n = 0;
  const rows: string[] = [];
  if (d.shortlist.length > 0) {
    n += 1;
    const items = d.shortlist
      .map(
        (s) =>
          `<div class="pick">${esc(s.letter)}) ${fitHtml({ score: s.fit, band: s.band })} · <b>${esc(s.company)}</b> ${esc(s.title)}` +
          `${s.location ? ` · ${esc(s.location)}` : ""} ${chips([...s.flags, ...s.badges])} ` +
          `${copyButton(`pick ${s.letter}`)} ${copyButton(`why ${s.letter}`, `Copy: why ${s.letter}`)}</div>`,
      )
      .join("");
    const all = d.shortlist.map((s) => s.letter).join(", ");
    rows.push(
      row(
        `${n}. Shortlist pick`,
        `<b>${d.shortlist.length} Listing${d.shortlist.length === 1 ? "" : "s"}</b> ready to pick from.${items}`,
        d.shortlist.length > 1 ? copyButton(`pick ${all}`, "Copy: pick all", true) : "",
      ),
    );
  }
  const ofStatus = (s: string) => d.apps.filter((a) => a.status === s);
  const who = (a: StoredRecord) => `<b>${esc(a.company)}</b> · ${esc(a.title)}`;
  for (const a of ofStatus("paused")) {
    n += 1;
    const field = (a.pause as { field?: string } | undefined)?.field;
    rows.push(
      row(
        `${n}. Apply paused`,
        `${who(a)}<div class="sub">${field ? `Paused at "${esc(field)}"` : "Apply is paused"}. Answer it, then run Apply again.</div>`,
        copyButton(`why ${a.id}`),
      ),
    );
  }
  for (const a of ofStatus("handover")) {
    n += 1;
    rows.push(
      row(
        `${n}. Handover`,
        `${who(a)}<div class="sub">Review the filled form, then click Submit yourself.</div>`,
        copyButton(`why ${a.id}`),
      ),
    );
  }
  for (const a of d.apps) {
    const change = a.pending_change as { to?: string; reason?: string } | undefined;
    if (!change) continue;
    n += 1;
    rows.push(
      row(
        `${n}. Digest change`,
        `${who(a)}<div class="sub">${esc(statusLabel(String(a.status)))} → ${esc(statusLabel(String(change.to)))}: ${esc(change.reason)}</div>`,
        copyButton(`approve ${n}`, `Copy: approve ${n}`, true),
      ),
    );
  }
  for (const f of d.failedSources) {
    rows.push(
      row("Source failed", `<b>${esc(f.company)}</b> ${esc(f.ats)}: ${esc(f.message)}`, ""),
    );
  }
  out.push(
    `<h1>Needs you <span class="chip">${n}</span></h1>`,
    `<div class="sub">${d.lastDiscover ? `Last Discover ${esc(d.lastDiscover)} · ` : ""}Page generated ${esc(timestamp())}. Buttons copy a reply to paste into your Claude Code session; this page changes nothing.</div>`,
    rows.length > 0
      ? `<div class="panel">${rows.join("")}</div>`
      : `<div class="panel"><div class="todo">Nothing needs you right now.</div></div>`,
  );

  const quiet = d.apps.filter(
    (a) => !["paused", "handover"].includes(String(a.status)) && !a.pending_change,
  );
  out.push(
    "<h2>Everything else</h2>",
    quiet.length === 0
      ? '<div class="sub">No other Applications.</div>'
      : `<div class="panel wrap"><table><tr><th>Company</th><th>Role</th><th>Status</th></tr>${quiet
          .map(
            (a) =>
              `<tr><td>${esc(a.company)}</td><td>${esc(a.title)}</td><td>${esc(statusLabel(String(a.status)))}${a.origin === "external" ? ' <span class="chip">External</span>' : ""}</td></tr>`,
          )
          .join("")}</table></div>`,
  );

  const excluded = d.listings.filter((l) => screenOf(l)?.outcome === "excluded");
  out.push(
    `<details class="excluded"><summary>Excluded (${excluded.length})</summary>${excluded
      .map((l) => {
        const s = screenOf(l) as Screen;
        const by = s.checks.find((c) => c.check === s.excluded_by);
        const why = by
          ? `${esc(by.name)}: ${esc(by.result)}. ${by.evidence.map(esc).join(" ")}`
          : "";
        return `<div class="todo"><div class="body"><b>${esc(l.company)}</b> · ${esc(l.title)}<div class="sub">${why}</div></div><div class="acts">${copyButton(`restore ${l.company} ${l.title}`)}</div></div>`;
      })
      .join("")}</details>`,
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------
// Board

const NEEDS_STATUS = new Set(["paused", "handover"]);

function boardTab(d: Data): string {
  const cols = Object.entries(STATUSES).map(([key, label]) => {
    const cards = d.apps.filter((a) => a.status === key);
    const listing = (a: StoredRecord) =>
      typeof a.listing === "string" ? d.listings.find((l) => l.id === a.listing) : undefined;
    return (
      `<div class="col" data-status="${key}"><h3>${esc(label)}<span>${cards.length}</span></h3>` +
      cards
        .map((a) => {
          const fit = fitHtml(screenOf(listing(a) ?? ({} as StoredRecord))?.fit);
          return `<div class="card${NEEDS_STATUS.has(key) ? " needs" : ""}"><b>${esc(a.company)}</b><br>${esc(a.title)}<div>${fit}${a.origin === "external" ? ' <span class="chip">External</span>' : ""}</div></div>`;
        })
        .join("") +
      "</div>"
    );
  });
  return `<h1>Board</h1><div class="sub">One column per Status. A blue edge means it needs you.</div><div class="board">${cols.join("")}</div>`;
}

// ---------------------------------------------------------------------------------------
// Listings

const LEGEND = [
  ["ok", "Passed"],
  ["warn", "Warning: down-ranks or adds a badge"],
  ["bad", "Failed: excludes the Listing"],
  ["nr", "Not reached"],
  ["human", "Your Approval"],
  ["out", "Outcome"],
]
  .map(([k, t]) => `<span class="key"><span class="sw ${k}"></span>${t}</span>`)
  .join("");

interface NodeInfo {
  title: string;
  lines: string[];
}

function listingDetail(l: StoredRecord, app: StoredRecord | undefined) {
  const s = screenOf(l);
  const head =
    `<h1>${esc(l.company)} · ${esc(l.title)}</h1><div class="sub">${esc(l.location ?? "")} · ${esc(l.source ?? "")}` +
    ` ${fitHtml(s?.fit)}</div>` +
    `<div>${chips([...(s?.flags ?? []), ...(s?.badges ?? [])].map((f) => f.label))}` +
    `${l.gone === true ? chips(["gone from its board"]) : ""}</div>`;
  const info: Record<string, NodeInfo> = {};
  let tree = "";
  let checks = "";
  if (s) {
    for (const c of s.checks) {
      info[nodeId(c.check)] = {
        title: `${c.name}: ${c.result}`,
        lines: [`Rule: ${c.rule}`, ...c.evidence],
      };
    }
    eventsOf(app).forEach((e, i) => {
      info[`e${i + 1}`] = {
        title: `${e.from ? `${statusLabel(e.from)} → ` : ""}${statusLabel(e.to)}`,
        lines: [
          `${e.stage} · ${e.at}`,
          e.reason,
          ...(e.approval
            ? [
                `Your Approval (${e.approval.checkpoint}, ${e.approval.approved_at}): ${e.approval.action}`,
              ]
            : []),
        ],
      };
    });
    const clicks = Object.keys(info).map((id) => `  click ${id} call jbNode("${id}")`);
    const src = `${renderTree(l, app).trimEnd()}\n${clicks.join("\n")}\n`.replace(
      /<\/script/gi,
      "<\\/script",
    );
    tree =
      `<h2>Decision tree <span class="sub">click a node for its evidence</span></h2><div class="legend">${LEGEND}</div>` +
      `<script type="text/x-mermaid">${src}</script><div class="tree"></div>` +
      '<div class="panel nodeinfo"><span class="sub">Click a node to see its rule and every piece of evidence.</span></div>';
    checks = `<ol class="checks">${s.checks
      .map(
        (c) =>
          `<li class="${CLASS[c.status]}"><span class="mark">${MARK[c.status]}</span> <b>${esc(c.name)}</b> ${esc(c.result)}` +
          (c.status === "not_reached"
            ? ""
            : `<div class="sub">rule: ${esc(c.rule)}</div><ul>${c.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`) +
          "</li>",
      )
      .join("")}</ol>`;
  }
  const log = eventsOf(app);
  const events =
    `<h2>Event log</h2>` +
    (log.length === 0
      ? '<div class="sub">No Application yet.</div>'
      : `<ul class="log">${log
          .map(
            (e) =>
              `<li><span class="sub">${esc(e.at)} · ${esc(e.stage)}</span> <b>${esc(e.from ? `${statusLabel(e.from)} → ` : "")}${esc(statusLabel(e.to))}</b> ${esc(e.reason)}` +
              `${e.approval ? ` <i>Approval: ${esc(e.approval.checkpoint)} (${esc(e.approval.action)})</i>` : ""}</li>`,
          )
          .join("")}</ul>`);
  return { html: head + tree + checks + events, info };
}

function listingsTab(d: Data): {
  html: string;
  nodeData: Record<string, Record<string, NodeInfo>>;
} {
  const nodeData: Record<string, Record<string, NodeInfo>> = {};
  const entries: { id: string; label: string; state: string; body: string }[] = [];
  for (const l of d.listings) {
    if (!screenOf(l)) continue;
    const app = d.appByListing.get(l.id);
    const { html, info } = listingDetail(l, app);
    nodeData[l.id] = info;
    const state = app
      ? statusLabel(String(app.status))
      : screenOf(l)?.outcome === "excluded"
        ? "Excluded"
        : l.gone === true
          ? "Gone"
          : "Shortlist";
    entries.push({
      id: l.id,
      label: `<b>${esc(l.company)}</b> ${esc(l.title)}`,
      state,
      body: html,
    });
  }
  for (const a of d.apps.filter((x) => typeof x.listing !== "string")) {
    const log = eventsOf(a);
    entries.push({
      id: a.id,
      label: `<b>${esc(a.company)}</b> ${esc(a.title)}`,
      state: `${statusLabel(String(a.status))} · External`,
      body:
        `<h1>${esc(a.company)} · ${esc(a.title)}</h1><div class="sub">Applied outside Job Butler</div>` +
        `<h2>Event log</h2>${log.length === 0 ? '<div class="sub">No events yet.</div>' : `<ul class="log">${log.map((e) => `<li>${esc(e.at)} ${esc(statusLabel(e.to))} ${esc(e.reason)}</li>`).join("")}</ul>`}`,
    });
  }
  const list = entries
    .map(
      (e, i) =>
        `<button type="button" class="${i === 0 ? "on" : ""}" data-select="${esc(e.id)}">${e.label}<br><span class="sub">${esc(e.state)}</span></button>`,
    )
    .join("");
  const details = entries
    .map(
      (e, i) =>
        `<article class="detail panel" data-listing="${esc(e.id)}"${i === 0 ? "" : " hidden"}>${e.body}</article>`,
    )
    .join("");
  return {
    html: `<div class="md"><div class="panel list">${list || '<div class="sub" style="padding:10px">No Listings yet.</div>'}</div><div>${details}</div></div>`,
    nodeData,
  };
}

// ---------------------------------------------------------------------------------------
// Page

const STYLE = `
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--strong:#1f7a4d;--partial:#9a6b00;--weak:#a33a2b;--accent:#2b59c3;--chip:#efeee8}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--panel:#1e1e1c;--ink:#ecebe6;--muted:#9a9a92;--line:#33332f;--strong:#5cc28f;--partial:#e0b04a;--weak:#ec7a68;--accent:#7ea2ff;--chip:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif;padding:16px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;margin:20px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.sub{color:var(--muted)}.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 8px;font-size:12px;margin-right:4px;white-space:nowrap}
.fit{font-weight:600}.strong{color:var(--strong)}.partial{color:var(--partial)}.weak{color:var(--weak)}
.btn{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.done{outline:2px solid var(--strong)}
[role=tablist]{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:16px}
[role=tab]{border:0;background:none;color:var(--muted);padding:8px 14px;font:inherit;cursor:pointer;border-bottom:2px solid transparent}
[role=tab][aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted);font-weight:500}.wrap{overflow-x:auto}
.todo{display:flex;gap:12px;align-items:flex-start;padding:12px;border-bottom:1px solid var(--line)}.todo:last-child{border-bottom:0}
.todo .kind{min-width:120px;font-size:12px;color:var(--muted)}.todo .body{flex:1}.todo .acts{display:flex;gap:6px;flex-wrap:wrap}.pick{margin-top:6px}
details.excluded{margin-top:16px}details summary{cursor:pointer;color:var(--muted)}
.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(190px,1fr);gap:10px;overflow-x:auto;padding-bottom:8px}
.col{background:var(--chip);border-radius:8px;padding:8px;min-height:120px}.col h3{font-size:12px;margin:2px 4px 8px;color:var(--muted);display:flex;justify-content:space-between}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px;margin-bottom:8px;font-size:13px}.card.needs{border-left:3px solid var(--accent)}
.md{display:grid;grid-template-columns:minmax(220px,320px) 1fr;gap:12px}@media(max-width:760px){.md{grid-template-columns:1fr}}
.list button{display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);padding:10px;color:var(--ink);cursor:pointer;font:inherit}.list button.on{background:var(--chip)}
.detail{padding:14px}.log li{margin-bottom:4px}[hidden]{display:none!important}
.legend{margin-bottom:6px}.key{display:inline-flex;align-items:center;gap:5px;margin:0 12px 4px 0;font-size:12px}
.sw{width:14px;height:14px;border-radius:3px;border:2px solid}
.sw.ok,.checks .ok .mark{background:#dff3e7;border-color:#1f7a4d}.sw.warn,.checks .warn .mark{background:#fff1cc;border-color:#b07d00}
.sw.bad,.checks .bad .mark{background:#fbe0dc;border-color:#a33a2b}.sw.nr,.checks .nr .mark{background:#f2f2f2;border:2px dashed #b5b5b5}
.sw.human{background:#dce7ff;border-color:#2b59c3}.sw.out{background:#ece0fb;border-color:#6b3fb0}
.checks{list-style:none;padding:0}.checks>li{margin:8px 0}.checks .mark{display:inline-block;min-width:20px;text-align:center;border-radius:4px;color:#1d1d1b}
.tree{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px;min-height:40px}.nodeinfo{padding:12px;margin-top:8px}
`;

const SCRIPT = `
(function(){
var data=JSON.parse(document.getElementById("jb-data").textContent),current=null,n=0;
function $(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}
function tab(id){$('[role=tab]').forEach(function(b){b.setAttribute("aria-selected",String(b.dataset.tab===id));});
$("section.tabpanel").forEach(function(p){p.hidden=p.id!=="tab-"+id;});if(id==="listings")show(current);}
$('[role=tab]').forEach(function(b){b.onclick=function(){tab(b.dataset.tab);};});
function copy(text,btn){function ok(){btn.classList.add("done");setTimeout(function(){btn.classList.remove("done");},1200);}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(ok,fallback);}else{fallback();}
function fallback(){var t=document.createElement("textarea");t.value=text;document.body.appendChild(t);t.select();try{document.execCommand("copy");ok();}catch(e){}t.remove();}}
$("[data-copy]").forEach(function(b){b.onclick=function(){copy(b.dataset.copy,b);};});
function show(id){var items=$("[data-select]");if(!items.length)return;if(!id)id=items[0].dataset.select;current=id;
items.forEach(function(b){b.classList.toggle("on",b.dataset.select===id);});
$("article[data-listing]").forEach(function(a){var on=a.dataset.listing===id;a.hidden=!on;if(on)draw(a);});}
$("[data-select]").forEach(function(b){b.onclick=function(){show(b.dataset.select);};});
function draw(a){var src=a.querySelector('script[type="text/x-mermaid"]'),box=a.querySelector(".tree");
if(!src||!box||box.dataset.drawn||!window.mermaid)return;box.dataset.drawn="1";
mermaid.render("jb"+(++n),src.textContent).then(function(r){box.innerHTML=r.svg;if(r.bindFunctions)r.bindFunctions(box);},function(){box.textContent="The diagram could not be drawn. The checks below hold the same evidence.";});}
window.jbNode=function(id){var info=(data[current]||{})[id],a=document.querySelector('article[data-listing="'+CSS.escape(current)+'"]'),p=a&&a.querySelector(".nodeinfo");if(!info||!p)return;
p.textContent="";var h=document.createElement("b");h.textContent=info.title;p.appendChild(h);var ul=document.createElement("ul");
info.lines.forEach(function(l){var li=document.createElement("li");li.textContent=l;ul.appendChild(li);});p.appendChild(ul);};
if(window.mermaid){mermaid.initialize({startOnLoad:false,securityLevel:"loose",theme:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"default"});}
})();
`;

export function renderPage(d: Data): string {
  const { html: listingsHtml, nodeData } = listingsTab(d);
  const json = JSON.stringify(nodeData).replace(/</g, "\\u003c");
  const tabs = [
    ["needs", "Needs you", needsTab(d)],
    ["board", "Board", boardTab(d)],
    ["listings", "Listings", listingsHtml],
  ] as const;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Butler: pipeline</title><style>${STYLE}</style></head>
<body>
<div role="tablist">${tabs
    .map(
      ([id, label], i) =>
        `<button type="button" role="tab" aria-selected="${i === 0}" data-tab="${id}">${label}</button>`,
    )
    .join("")}</div>
${tabs.map(([id, , body], i) => `<section class="tabpanel" id="tab-${id}"${i === 0 ? "" : " hidden"}>${body}</section>`).join("\n")}
<script type="application/json" id="jb-data">${json}</script>
<script src="${MERMAID_FILE}"></script>
<script>${SCRIPT}</script>
</body></html>
`;
}

/** Write the page and its bundled Mermaid into <data>/view/. Reads records; takes no lock. */
export async function regenerateView(dataDir: string): Promise<string> {
  const html = renderPage(await load(dataDir));
  const dir = join(dataDir, VIEW_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const bundle = join(dir, MERMAID_FILE);
  const [want, have] = await Promise.all([
    stat(MERMAID_SOURCE),
    stat(bundle).catch(() => undefined),
  ]);
  if (have?.size !== want.size) {
    await copyFile(MERMAID_SOURCE, `${bundle}.tmp-${process.pid}`);
    await rename(`${bundle}.tmp-${process.pid}`, bundle);
  }
  const file = join(dataDir, VIEW_FILE);
  await writeThenReplace(file, html);
  return file;
}

/** Open the page in the browser; false when the opener could not run. */
export async function openView(file: string): Promise<boolean> {
  try {
    await promisify(execFile)(openerCommand(), [file], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}
