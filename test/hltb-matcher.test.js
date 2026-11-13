const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHltbMatcher } = require("../hltb-matcher");

const empty = { LowestPrice: "", MainStory: "", MainExtra: "", Completionist: "" };

test("matches exact editions first and falls back to the base game", () => {
  const match = createHltbMatcher([
    { game_id: 1, game_name: "Example Game", comp_main: 5400, comp_plus: 9000, comp_100: 0 },
    { game_id: 2, game_name: "Example Game: Complete Edition", comp_main: 14400 },
    { game_id: 3, game_name: "Ultimate Chicken Horse", comp_main: 3600 },
  ]);
  assert.deepEqual(match("Example Game: Complete Edition"), {
    LowestPrice: "/game/2", MainStory: 4, MainExtra: "", Completionist: "",
  });
  assert.deepEqual(match("Example Game – Digital Deluxe Edition PS4 & PS5"), {
    LowestPrice: "/game/1", MainStory: 2, MainExtra: 3, Completionist: "",
  });
  assert.equal(match("Ultimate Chicken Horse").LowestPrice, "/game/3");
  assert.deepEqual(match("Example Game 2 Deluxe Edition"), empty);
  assert.deepEqual(match("Example Game and Other Game Bundle"), empty);
  assert.deepEqual(match("Example Game: Directors Cut"), empty);
  assert.deepEqual(createHltbMatcher([])("Example Game"), empty);
});

test("uses Switch's 0.9 token similarity threshold", () => {
  const match = createHltbMatcher([
    { game_id: 10, game_name: "one two three four five six seven eight nine ten", comp_main: 3600 },
  ]);
  assert.equal(match("one two three four five six seven eight nine ten eleven").LowestPrice, "/game/10");
  assert.deepEqual(match("one two three four five six seven eight nine ten eleven twelve"), empty);
});

test("removes trademarks and PlayStation Hits branding before matching", () => {
  const match = createHltbMatcher([
    { game_id: 7, game_name: "The Last of Us Remastered", comp_main: 3600 },
  ]);
  assert.equal(match("THE LAST OF US™ REMASTERED PLAYSTATION®HITS").LowestPrice, "/game/7");
});

test("removes parenthesized text from store and HLTB titles", () => {
  const match = createHltbMatcher([
    { game_id: 8, game_name: "Example Game (English)", comp_main: 3600 },
  ]);
  assert.equal(match("Example Game (English, Japanese)").LowestPrice, "/game/8");
  assert.equal(match("Example Game (Deluxe Edition)").LowestPrice, "/game/8");
  assert.deepEqual(match("Unrelated Game (Example Game)"), empty);
});

test("merge recalculates and clears all HLTB fields on each run", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-hltb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  write("en-id_campaign_deals.json", [{ Title: "Example Game Deluxe Edition", Slug: "example-ps5" }]);
  const hltb = [{ game_id: 5, game_name: "Example Game", comp_main: 3600, comp_plus: 7200, comp_100: 10800 }];
  const run = () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "merge-en-csvs.js")], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(path.join(dir, "csvjsontr.json"), "utf8"))[0];
  };
  write("hltb_ps.json", hltb);
  let row = run();
  assert.deepEqual([row.LowestPrice, row.MainStory, row.MainExtra, row.Completionist], ["/game/5", 1, 2, 3]);
  hltb[0].game_id = 6;
  hltb[0].comp_main = 0;
  hltb[0].comp_plus = 14400;
  write("hltb_ps.json", hltb);
  row = run();
  assert.deepEqual([row.LowestPrice, row.MainStory, row.MainExtra, row.Completionist], ["/game/6", "", 4, 3]);
  write("hltb_ps.json", []);
  row = run();
  assert.deepEqual([row.LowestPrice, row.MainStory, row.MainExtra, row.Completionist], ["", "", "", ""]);
  const csv = fs.readFileSync(path.join(dir, "csvjsontr.csv"), "utf8");
  assert.ok(csv.includes("example-ps5"));
});