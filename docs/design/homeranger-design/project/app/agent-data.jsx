/* HomeRanger — estate-agent directory, discovery + ComplianceGuard mirror.

   Canonical model (ported from backend-core):
   - Discovery SOURCES candidate agents in a search's patch (by outcode).
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

/* Derive the search's target outcodes (saved, else parsed from the location). */
function searchOutcodes(search) {
  if (search && search.outcodes && search.outcodes.length) return search.outcodes.map((o) => o.toUpperCase());
  const parsed = ((search && search.location) || "").match(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\b/gi) || [];
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

/* discoverAgents — the candidate set for a search's patch. */
function discoverAgents(search) {
  const codes = searchOutcodes(search);
  const region = ((search.location || search.name || "this area").split(/[,—–-]/)[0] || "").trim() || "this area";
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
        coverage: coverageFor(a.agencyName, oc),
        area: search.location || region,
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

/* ---- Coverage patches -----------------------------------------------------
   What each agency actually works, not just its HQ outcode. Real branches
   cover a spread of neighbouring outcodes; this is the source of the "too many
   chips" problem the coverage cell solves by rolling up to the postcode area.
   Keyed by agency name (unique across patches here). The HQ outcode leads. */
const COVERAGE = {
  // Snowdonia / Gwynedd — wide rural LL patches
  "Dafydd Hardy": ["LL55", "LL54", "LL56", "LL57", "LL49", "LL51"],
  "Iwan M Williams": ["LL55", "LL54", "LL77"],
  "Tom Parry": ["LL48", "LL49", "LL51", "LL52", "LL47"],
  "Walter Lloyd Jones": ["LL48", "LL49", "LL47"],
  "Welsh Country Homes": ["LL40", "LL42", "LL43", "LL44", "LL36"],
  "Beresford Adams": ["LL40", "LL42", "LL36", "LL35"],
  // Mid Wales — Powys SY / LD
  "Morris Marshall & Poole": ["SY18", "SY17", "SY19", "SY16", "SY20"],
  "Roger Parry & Partners": ["SY18", "SY21", "SY22", "SY16", "SY15"],
  "Norman Lloyd": ["SY16", "SY17", "SY15", "SY18"],
  "McCartneys": ["LD1", "LD2", "LD3", "LD6", "SY18"],
  // Hampstead — NW with a few N / W edges (multi-area)
  "Goldschmidt & Howland": ["NW3", "NW6", "NW8", "NW1", "NW5"],
  "Benham & Reeves": ["NW3", "NW6", "NW8"],
  "Knight Frank": ["NW3", "NW1", "NW8", "NW6", "N6", "W1"],
  "Foxtons": ["NW3", "NW1", "NW5", "NW6", "N6", "N19"],
  "Heathgate": ["NW3", "NW11", "N2"],
  // Bermondsey & SE London
  "Field & Sons": ["SE16", "SE1", "SE8", "SE15", "SE14"],
  "Pedder": ["SE1", "SE16", "SE15", "SE22", "SE4"],
  "Aspire": ["SE15", "SE22", "SE5", "SE4"],
  "Conran Estates": ["SE8", "SE16", "SE14", "SE10"],
  "Acorn": ["SE16", "SE1", "SE8", "SE15"],
  "Daniel Cobb": ["SE1", "SE16", "SE17", "SE11"],
  "Roy Brooks": ["SE15", "SE22", "SE4", "SE5"],
};

function coverageFor(agencyName, outcode) {
  const list = COVERAGE[agencyName] || (outcode ? [outcode] : []);
  // Dedupe, keep order, ensure the HQ outcode leads if present.
  const seen = new Set();
  const out = [];
  [outcode, ...list].forEach((o) => {
    const u = (o || "").toUpperCase();
    if (u && !seen.has(u)) { seen.add(u); out.push(u); }
  });
  return out;
}

/* ---- Outcode → place ------------------------------------------------------
   Postcode letters don't describe anywhere; a town/county does. This maps each
   outcode in use to [town, county/region] so the table can say "Gwynedd" or
   "around Caernarfon" instead of "LL". Extend as new patches are worked. */
const OUTCODE_PLACE = {
  // Gwynedd (Snowdonia)
  LL55: ["Caernarfon", "Gwynedd"], LL54: ["Caernarfon", "Gwynedd"], LL56: ["Y Felinheli", "Gwynedd"],
  LL57: ["Bangor", "Gwynedd"], LL49: ["Porthmadog", "Gwynedd"], LL51: ["Caernarfon", "Gwynedd"],
  LL48: ["Penrhyndeudraeth", "Gwynedd"], LL52: ["Criccieth", "Gwynedd"], LL47: ["Harlech", "Gwynedd"],
  LL40: ["Dolgellau", "Gwynedd"], LL42: ["Barmouth", "Gwynedd"], LL43: ["Talybont", "Gwynedd"],
  LL44: ["Dyffryn Ardudwy", "Gwynedd"], LL36: ["Tywyn", "Gwynedd"], LL35: ["Aberdyfi", "Gwynedd"],
  LL77: ["Llangefni", "Anglesey"],
  // Powys (Mid Wales)
  SY18: ["Llanidloes", "Powys"], SY17: ["Caersws", "Powys"], SY19: ["Llanbrynmair", "Powys"],
  SY16: ["Newtown", "Powys"], SY20: ["Machynlleth", "Powys"], SY21: ["Welshpool", "Powys"],
  SY22: ["Llanfechain", "Powys"], SY15: ["Montgomery", "Powys"],
  LD1: ["Llandrindod Wells", "Powys"], LD2: ["Builth Wells", "Powys"], LD3: ["Brecon", "Powys"], LD6: ["Knighton", "Powys"],
  // North London
  NW3: ["Hampstead", "North London"], NW6: ["West Hampstead", "North London"], NW8: ["St John's Wood", "North London"],
  NW1: ["Camden", "North London"], NW5: ["Kentish Town", "North London"], NW11: ["Golders Green", "North London"],
  N6: ["Highgate", "North London"], N2: ["East Finchley", "North London"], N19: ["Archway", "North London"],
  W1: ["Marylebone", "Central London"],
  // South East London
  SE16: ["Bermondsey", "South East London"], SE1: ["Southwark", "South East London"], SE8: ["Deptford", "South East London"],
  SE15: ["Peckham", "South East London"], SE14: ["New Cross", "South East London"], SE22: ["East Dulwich", "South East London"],
  SE4: ["Brockley", "South East London"], SE5: ["Camberwell", "South East London"], SE10: ["Greenwich", "South East London"],
  SE17: ["Walworth", "South East London"], SE11: ["Kennington", "South East London"],
};

function placeFor(outcode) {
  const oc = (outcode || "").toUpperCase();
  return OUTCODE_PLACE[oc] || [oc, (oc.match(/^[A-Z]+/) || [oc])[0]];
}

/* coverageSummary — rolls a coverage list up to its dominant county/region for
   the table ("Gwynedd · 5 outcodes"), and groups the outcodes by town for the
   detail popover — so the cell reads as a place, not a sort code. */
function coverageSummary(coverage) {
  const list = (coverage || []).map((o) => o.toUpperCase());
  const regionCount = {};
  const regionOrder = [];
  const groups = {};      // town -> [outcodes]
  const townOrder = [];
  const townRegion = {};  // town -> region (for ordering)
  list.forEach((oc) => {
    const [town, region] = placeFor(oc);
    if (regionCount[region] == null) { regionCount[region] = 0; regionOrder.push(region); }
    regionCount[region] += 1;
    if (!groups[town]) { groups[town] = []; townOrder.push(town); townRegion[town] = region; }
    groups[town].push(oc);
  });
  // Dominant region = most outcodes (first-seen breaks ties).
  const regions = [...regionOrder].sort((a, b) => regionCount[b] - regionCount[a]);
  const region = regions[0] || null;
  const primary = list[0] || null;
  const primaryTown = primary ? placeFor(primary)[0] : null;
  return { count: list.length, region, regions, groups, towns: townOrder, townRegion, primary, primaryTown };
}

/* ---- Seed: agents already pulled + contacted for the standing searchs ------ */
function mkAgent(agencyName, email, outcode, searchId, searchName, status, last) {
  return {
    id: agentId(agencyName, outcode),
    agencyName, email, outcode,
    coverage: coverageFor(agencyName, outcode),
    searchId, searchName,
    area: searchName,
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
  // Bermondsey family home (paused search — still keeps its contacts)
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
  searchOutcodes, listingsForAgency, SEED_AGENTS, agentId,
  coverageFor, coverageSummary, placeFor,
});
