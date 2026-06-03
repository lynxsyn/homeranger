/* HomeRanger — estate-agent directory, discovery + ComplianceGuard mirror.

   Canonical model (ported from backend-core):
   - Discovery SOURCES candidate agents in a scout's patch (by outcode).
   - ComplianceGuard gates every send, IN ORDER, on the first failure:
       1. PECR  — mailboxType must be corporate_subscriber
       2. opt-out
       3. suppression
       (4. reputation breaker — omitted in the prototype)
       5. kill-switch (global "sending paused")
       6. warm-up daily cap
   - Only agents that pass the guard AND the operator approves get contacted,
     and those persist into the Agents table (status flows replied/awaiting/…).

   The Launch loop shows the eligible/blocked split so the candour the brand
   prizes is visible: you see exactly who can't be written to, and why. */

/* ---- ComplianceGuard reason codes → human labels -------------------------- */
const REASON_LABEL = {
  PECR_NON_CORPORATE: "Not corporate",
  OPTED_OUT: "Opted out",
  SUPPRESSED: "Suppressed",
  CIRCUIT_OPEN: "Breaker open",
  KILL_SWITCH: "Sending paused",
  WARMUP_CAP_EXCEEDED: "Cap reached",
};

/* ---- Agent status (post-contact) → pill meta ------------------------------ */
const AGENT_STATUS = {
  replied:   { label: "Replied",       cls: "replied",  dot: true },
  awaiting:  { label: "Awaiting reply", cls: "awaiting", dot: true },
  queued:    { label: "Queued",        cls: "queued",   dot: false },
  opted_out: { label: "Opted out",     cls: "opted",    dot: true },
};

function agentSlug(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function agentId(name, outcode) {
  return `agt-${agentSlug(name)}-${(outcode || "").toLowerCase()}`;
}

/* ---- The patch directory --------------------------------------------------
   Candidate agents per outcode. Most are corporate subscribers (lawful to
   write to); a few are individuals or opted-out, so the guard has something to
   block — exactly the mix the real ComplianceGuard exists to handle. */
const DIRECTORY = {
  // Bermondsey & SE London
  SE16: [
    { agencyName: "Field & Sons", email: "info@fieldandsons.co.uk", mailboxType: "corporate_subscriber" },
    { agencyName: "Acorn", email: "bermondsey@acorn.ltd.uk", mailboxType: "corporate_subscriber" },
    { agencyName: "M. Goss Lettings", email: "maria.goss@gmail.com", mailboxType: "individual" },
  ],
  SE1: [
    { agencyName: "Pedder", email: "bermondsey@pedderproperty.com", mailboxType: "corporate_subscriber" },
    { agencyName: "Daniel Cobb", email: "hello@danielcobb.co.uk", mailboxType: "corporate_subscriber" },
  ],
  SE15: [
    { agencyName: "Aspire", email: "peckham@aspire.co.uk", mailboxType: "corporate_subscriber" },
    { agencyName: "Roy Brooks", email: "mail@roybrooks.co.uk", mailboxType: "corporate_subscriber", optedOut: true },
  ],
  SE8: [
    { agencyName: "Conran Estates", email: "deptford@conranestates.co.uk", mailboxType: "corporate_subscriber" },
  ],
  // Snowdonia
  LL55: [
    { agencyName: "Dafydd Hardy", email: "caernarfon@dafyddhardy.co.uk", mailboxType: "corporate_subscriber" },
    { agencyName: "Iwan M Williams", email: "post@iwanmwilliams.co.uk", mailboxType: "corporate_subscriber" },
  ],
  LL48: [
    { agencyName: "Tom Parry", email: "info@tomparry.co.uk", mailboxType: "corporate_subscriber" },
    { agencyName: "Walter Lloyd Jones", email: "sales@walterlloydjones.co.uk", mailboxType: "corporate_subscriber", optedOut: true },
  ],
  LL40: [
    { agencyName: "Welsh Country Homes", email: "hello@welshcountryhomes.co.uk", mailboxType: "corporate_subscriber" },
    { agencyName: "Beresford Adams", email: "dolgellau@beresfordadams.co.uk", mailboxType: "corporate_subscriber" },
  ],
  // Mid Wales — Powys
  SY18: [
    { agencyName: "Morris Marshall & Poole", email: "llanidloes@mmandp.co.uk", mailboxType: "corporate_subscriber" },
    { agencyName: "Roger Parry & Partners", email: "welshpool@rogerparry.net", mailboxType: "corporate_subscriber" },
  ],
  SY16: [
    { agencyName: "Norman Lloyd", email: "newtown@normanlloyd.com", mailboxType: "corporate_subscriber" },
  ],
  LD1: [
    { agencyName: "McCartneys", email: "llandrindod@mccartneys.co.uk", mailboxType: "corporate_subscriber" },
  ],
  // Hampstead
  NW3: [
    { agencyName: "Goldschmidt & Howland", email: "hampstead@gandh.co.uk", mailboxType: "corporate_subscriber" },
    { agencyName: "Benham & Reeves", email: "hampstead@benhams.com", mailboxType: "corporate_subscriber" },
    { agencyName: "Knight Frank", email: "hampstead@knightfrank.com", mailboxType: "corporate_subscriber" },
    { agencyName: "Foxtons", email: "hampstead@foxtons.co.uk", mailboxType: "corporate_subscriber" },
    { agencyName: "Heathgate", email: "info@heathgate.co.uk", mailboxType: "corporate_subscriber", optedOut: true },
    { agencyName: "R. Fenwick", email: "j.fenwick@outlook.com", mailboxType: "individual" },
  ],
};

/* Derive the scout's target outcodes (saved, else parsed from the location). */
function scoutOutcodes(scout) {
  if (scout && scout.outcodes && scout.outcodes.length) return scout.outcodes.map((o) => o.toUpperCase());
  const parsed = ((scout && scout.location) || "").match(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\b/gi) || [];
  return parsed.map((o) => o.toUpperCase());
}

/* Deterministic, network-free fallback — mirrors backend-core's
   FakeAgentDiscoveryProvider so a brand-new patch still surfaces candidates. */
function fakeAgentsFor(region, outcode) {
  const slug = agentSlug(region) || "region";
  return [
    { agencyName: `${region} Estates`, email: `info@${slug}-estates.example`, mailboxType: "corporate_subscriber", outcode },
    { agencyName: `${region} Property Co`, email: `sales@${slug}-property.example`, mailboxType: "corporate_subscriber", outcode },
  ];
}

/* discoverAgents — the candidate set for a scout's patch. */
function discoverAgents(scout) {
  const codes = scoutOutcodes(scout);
  const region = ((scout.location || scout.name || "this area").split(/[,—–-]/)[0] || "").trim() || "this area";
  const out = [];
  const seen = new Set();
  const buckets = codes.length ? codes : ["AREA"];
  buckets.forEach((code) => {
    const list = DIRECTORY[code] || fakeAgentsFor(region, code === "AREA" ? "" : code);
    list.forEach((a) => {
      const oc = a.outcode || (code === "AREA" ? "" : code);
      const id = agentId(a.agencyName, oc);
      if (seen.has(id)) return;
      seen.add(id);
      out.push({
        id,
        agencyName: a.agencyName,
        email: a.email,
        outcode: oc,
        area: scout.location || region,
        mailboxType: a.mailboxType || "corporate_subscriber",
        optedOut: !!a.optedOut,
        suppressed: !!a.suppressed,
      });
    });
  });
  return out;
}

/* complianceCheck — the guard's gate order, on the first failure.
   ctx.sending=false models the global kill-switch being ON (sending paused). */
function complianceCheck(agent, ctx) {
  ctx = ctx || {};
  if (agent.mailboxType !== "corporate_subscriber") return { eligible: false, code: "PECR_NON_CORPORATE" };
  if (agent.optedOut) return { eligible: false, code: "OPTED_OUT" };
  if (agent.suppressed) return { eligible: false, code: "SUPPRESSED" };
  if (ctx.sending === false) return { eligible: false, code: "KILL_SWITCH" };
  if (ctx.warmupFull) return { eligible: false, code: "WARMUP_CAP_EXCEEDED" };
  return { eligible: true, code: null };
}

/* Homes a given agency has already sent in (links agents → listings). */
function listingsForAgency(name) {
  if (!window.LISTINGS) return 0;
  return window.LISTINGS.filter((l) => l.agency === name).length;
}

/* ---- Seed: agents already pulled + contacted for the standing scouts ------ */
function mkAgent(agencyName, email, outcode, scoutId, scoutName, status, last) {
  return {
    id: agentId(agencyName, outcode),
    agencyName, email, outcode,
    scoutId, scoutName,
    area: scoutName,
    mailboxType: "corporate_subscriber",
    optedOut: status === "opted_out",
    status, lastContact: last,
  };
}

const SEED_AGENTS = [
  // Snowdonia — detached with a view
  mkAgent("Dafydd Hardy", "caernarfon@dafyddhardy.co.uk", "LL55", "cmp-snowdonia", "Snowdonia — detached with a view", "replied", "2h ago"),
  mkAgent("Tom Parry", "info@tomparry.co.uk", "LL48", "cmp-snowdonia", "Snowdonia — detached with a view", "replied", "1d ago"),
  mkAgent("Welsh Country Homes", "hello@welshcountryhomes.co.uk", "LL40", "cmp-snowdonia", "Snowdonia — detached with a view", "replied", "2d ago"),
  mkAgent("Iwan M Williams", "post@iwanmwilliams.co.uk", "LL55", "cmp-snowdonia", "Snowdonia — detached with a view", "awaiting", "3d ago"),
  mkAgent("Beresford Adams", "dolgellau@beresfordadams.co.uk", "LL40", "cmp-snowdonia", "Snowdonia — detached with a view", "awaiting", "4d ago"),
  mkAgent("Walter Lloyd Jones", "sales@walterlloydjones.co.uk", "LL48", "cmp-snowdonia", "Snowdonia — detached with a view", "opted_out", "1w ago"),
  // Rural restoration project
  mkAgent("Morris Marshall & Poole", "llanidloes@mmandp.co.uk", "SY18", "cmp-restoration", "Rural restoration project", "replied", "1d ago"),
  mkAgent("McCartneys", "llandrindod@mccartneys.co.uk", "LD1", "cmp-restoration", "Rural restoration project", "replied", "3d ago"),
  mkAgent("Norman Lloyd", "newtown@normanlloyd.com", "SY16", "cmp-restoration", "Rural restoration project", "awaiting", "2d ago"),
  mkAgent("Roger Parry & Partners", "welshpool@rogerparry.net", "SY18", "cmp-restoration", "Rural restoration project", "awaiting", "5d ago"),
  // Hampstead pied-à-terre
  mkAgent("Goldschmidt & Howland", "hampstead@gandh.co.uk", "NW3", "cmp-hampstead", "Hampstead pied-à-terre", "replied", "3h ago"),
  mkAgent("Benham & Reeves", "hampstead@benhams.com", "NW3", "cmp-hampstead", "Hampstead pied-à-terre", "replied", "1d ago"),
  mkAgent("Knight Frank", "hampstead@knightfrank.com", "NW3", "cmp-hampstead", "Hampstead pied-à-terre", "awaiting", "2d ago"),
  mkAgent("Foxtons", "hampstead@foxtons.co.uk", "NW3", "cmp-hampstead", "Hampstead pied-à-terre", "awaiting", "4d ago"),
  mkAgent("Heathgate", "info@heathgate.co.uk", "NW3", "cmp-hampstead", "Hampstead pied-à-terre", "opted_out", "1w ago"),
  // Bermondsey family home (paused scout — still keeps its contacts)
  mkAgent("Field & Sons", "info@fieldandsons.co.uk", "SE16", "cmp-bermondsey", "Bermondsey family home", "replied", "2h ago"),
  mkAgent("Pedder", "bermondsey@pedderproperty.com", "SE1", "cmp-bermondsey", "Bermondsey family home", "replied", "5h ago"),
  mkAgent("Aspire", "peckham@aspire.co.uk", "SE15", "cmp-bermondsey", "Bermondsey family home", "replied", "1d ago"),
  mkAgent("Conran Estates", "deptford@conranestates.co.uk", "SE8", "cmp-bermondsey", "Bermondsey family home", "awaiting", "2d ago"),
  mkAgent("Acorn", "bermondsey@acorn.ltd.uk", "SE16", "cmp-bermondsey", "Bermondsey family home", "awaiting", "3d ago"),
  mkAgent("Daniel Cobb", "hello@danielcobb.co.uk", "SE1", "cmp-bermondsey", "Bermondsey family home", "awaiting", "4d ago"),
  mkAgent("Roy Brooks", "mail@roybrooks.co.uk", "SE15", "cmp-bermondsey", "Bermondsey family home", "opted_out", "1w ago"),
];

Object.assign(window, {
  REASON_LABEL, AGENT_STATUS, discoverAgents, complianceCheck,
  scoutOutcodes, listingsForAgency, SEED_AGENTS, agentId,
});
