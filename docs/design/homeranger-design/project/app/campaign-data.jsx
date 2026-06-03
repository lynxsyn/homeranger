/* HomeRanger — campaigns. Each campaign is a standing brief the email agent
   works from: where to look, what kind of home, the budget, the condition and
   land rules, and a free-text description of your taste that shapes the emails
   sent to estate agents and how their replies are scored. */
const PROPERTY_TYPES = [
  "Detached", "Semi-detached", "Terraced", "Flat", "Maisonette",
  "Bungalow", "Cottage", "Farmhouse", "Barn", "Land",
];

// How much of a project you'll take on (agents describe condition in their email).
const CONDITIONS = ["Move-in ready", "Some updating", "Full renovation", "Restoration project"];

// When land is acceptable — only on these terms.
const LAND_OPTIONS = ["Land with a building to convert", "Buildable land or planning potential"];

// Which sale routes to hear about.
const SALE_METHODS = ["Private treaty", "Auction"];

const CAMPAIGNS = [
  {
    id: "cmp-snowdonia",
    name: "Snowdonia — detached with a view",
    location: "Snowdonia, Gwynedd",
    outcodes: ["LL55", "LL48", "LL40"],
    types: ["Detached", "Cottage"],
    condition: ["Some updating", "Full renovation"],
    land: [],
    saleMethods: ["Private treaty", "Auction"],
    minBeds: 3,
    maxPrice: 650000,
    keywords:
      "A detached stone house or cottage with proper mountain views and a bit of land. Wood burner, original features, somewhere you can hear nothing but weather. Happy to be remote and to do some work.",
    status: "active",
    agents: 9,
    lastActivity: "2h ago",
    created: "Apr 2026",
  },
  {
    id: "cmp-restoration",
    name: "Rural restoration project",
    location: "Mid Wales — Powys",
    outcodes: ["SY18", "LD1", "SY16"],
    types: ["Farmhouse", "Barn", "Cottage", "Land"],
    condition: ["Full renovation", "Restoration project"],
    land: ["Land with a building to convert", "Buildable land or planning potential"],
    saleMethods: ["Private treaty", "Auction"],
    minBeds: "",
    maxPrice: 400000,
    keywords:
      "Somewhere to restore from the ground up — a derelict farmhouse or barn to convert, or a buildable plot with planning or genuine potential. Off-grid is fine. Land and outbuildings a big plus. Keen on auction lots.",
    status: "active",
    agents: 6,
    lastActivity: "1d ago",
    created: "Jun 2026",
  },
  {
    id: "cmp-hampstead",
    name: "Hampstead pied-à-terre",
    location: "Hampstead, NW3",
    outcodes: ["NW3"],
    types: ["Flat"],
    condition: ["Move-in ready", "Some updating"],
    land: [],
    saleMethods: ["Private treaty"],
    minBeds: 1,
    maxPrice: 750000,
    keywords:
      "A characterful one-bed in a period conversion — high ceilings, big windows, lots of light. Quiet street, walkable to the Heath and a good café. Lift not needed, character essential.",
    status: "active",
    agents: 14,
    lastActivity: "5h ago",
    created: "Mar 2026",
  },
  {
    id: "cmp-bermondsey",
    name: "Bermondsey family home",
    location: "Bermondsey & Rotherhithe — SE16, SE1",
    outcodes: ["SE16", "SE1", "SE15", "SE8"],
    types: ["Terraced", "Semi-detached"],
    condition: ["Move-in ready", "Some updating"],
    land: [],
    saleMethods: ["Private treaty"],
    minBeds: 3,
    maxPrice: 700000,
    keywords:
      "A bright period terrace with original floors, a fireplace if possible, and a proper south-facing garden. Walkable to a park and a decent coffee. Light work fine, not a full renovation.",
    status: "paused",
    agents: 22,
    lastActivity: "3d ago",
    created: "Feb 2026",
  },
];

window.CAMPAIGNS = CAMPAIGNS;
window.PROPERTY_TYPES = PROPERTY_TYPES;
window.CONDITIONS = CONDITIONS;
window.LAND_OPTIONS = LAND_OPTIONS;
window.SALE_METHODS = SALE_METHODS;
