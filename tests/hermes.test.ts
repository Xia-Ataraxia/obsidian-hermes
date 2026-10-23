import { expect, test } from "bun:test";
import { dropMove, parseProfiles, yamlField } from "../src/hermes/data";
import { curve, snap } from "../src/hermes/geometry";
import { parseSections } from "../src/hermes/remote";

test("snap locks edges within threshold and emits a guide", () => {
  const other = { x: 0, y: 0, w: 100, h: 50 };
  const result = snap({ x: 104, y: 200, w: 100, h: 50 }, [other], 6);
  expect(result.x).toBe(100);
  expect(result.guides.some(guide => guide.axis === "x" && guide.at === 100)).toBe(true);
  expect(snap({ x: 120, y: 200, w: 100, h: 50 }, [other], 6).x).toBe(120);
});

test("curve leaves both cards and bows A→B apart from B→A", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 }, b = { x: 400, y: 0, w: 100, h: 100 };
  const there = curve(a, b, 6), back = curve(b, a, 6);
  expect(there.start[0]).toBeGreaterThan(100);
  expect(there.end[0]).toBeLessThan(400);
  expect(Math.sign(there.mid[1] - 50)).toBe(-Math.sign(back.mid[1] - 50));
});

test("sections, yaml and profiles parse from one remote dump", () => {
  const dump = [
    "noise", "\u001enow\n1000",
    "\u001eprofile ops\ndescription: >\n  Runs the\n  ops desk\n",
    "\u001emodel ops\n  default: \"gpt-5\"\n  provider: openai",
    "\u001efiles ops\n{\"skills\":[[\"deploy\",\"devops\",\"Ship it\"]],\"jobs\":[{\"id\":\"j1\",\"name\":\"\",\"schedule\":\"0 9 * * *\",\"enabled\":1}]}",
    "\u001eprofile qa\n",
    "\u001egraph default\n{\"edges\":[[\"ops\",\"qa\",3],[\"ops\",\"ghost\",9]],\"load\":[[\"qa\",\"triage\",2]],\"done\":[[\"ops\",4]]}",
  ].join("\n");
  const sections = parseSections(dump);
  expect(sections.get("now")).toBe("1000");
  expect(yamlField(sections.get("profile ops")!, "description")).toBe("Runs the ops desk");
  const snapshot = parseProfiles(sections);
  const ops = snapshot.profiles.find(profile => profile.id === "ops")!;
  expect(ops.model).toBe("gpt-5");
  expect(ops.jobs[0]).toMatchObject({ name: "j1", enabled: true });
  expect(ops.load.done7d).toBe(4);
  expect(snapshot.profiles.find(profile => profile.id === "qa")!.load.todo).toBe(2);
  expect(snapshot.edges).toEqual([{ from: "ops", to: "qa", weight: 3 }]);
});

test("dropMove maps lanes to CLI verbs", () => {
  expect(dropMove("running", "done")).toBe("complete");
  expect(dropMove("done", "blocked")).toBeNull();
  expect(dropMove("blocked", "ready")).toBe("unblock");
  expect(dropMove("triage", "ready")).toBe("promote");
  expect(dropMove("running", "ready")).toBeNull();
  expect(dropMove("todo", "review")).toBeNull();
});
