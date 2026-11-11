// Deals are kept in data/deals.json. Only the plan and the PayPal invoice IDs are
// stored here; invoice status always comes live from PayPal.
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DIR, "deals.json");

function readAll() {
  if (!fs.existsSync(FILE)) return [];
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}

function writeAll(deals) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(deals, null, 2));
  fs.renameSync(tmp, FILE);
}

function listDeals() {
  return readAll();
}

function getDeal(id) {
  return readAll().find((d) => d.id === id) || null;
}

function saveDeal(deal) {
  const deals = readAll();
  const i = deals.findIndex((d) => d.id === deal.id);
  if (i === -1) deals.push(deal);
  else deals[i] = deal;
  writeAll(deals);
  return deal;
}

module.exports = { listDeals, getDeal, saveDeal };
