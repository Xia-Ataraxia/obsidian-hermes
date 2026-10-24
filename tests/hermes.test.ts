import { expect, test } from "bun:test";
import { HermesClient, parseProfiles, yamlField } from "../src/hermes/data";
import { curve, snap, tidy } from "../src/hermes/geometry";
import { parseSections } from "../src/hermes/remote";

test("snap locks edges within threshold and emits a guide", () => {
  const other = { x: 0, y: 0, w: 100, h: 50 };
  const result = snap({ x: 104, y: 200, w: 100, h: 50 }, [other], 6);
  expect(result.x).toBe(100);
  expect(result.guides).toEqual([{ axis: "x", at: 100, center: false, marks: [200, 250, 0, 50] }]);
  expect(result.targets).toEqual([0]);
  expect(snap({ x: 26, y: 200, w: 50, h: 50 }, [other], 6).guides[0]).toMatchObject({ at: 50, center: true });
  expect(snap({ x: 120, y: 200, w: 100, h: 50 }, [other], 6).x).toBe(120);
});

test("snap centers a rect between two neighbors and matches an existing gap", () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };
  const centered = snap({ x: 148, y: 10, w: 100, h: 50 }, [a, { x: 300, y: 0, w: 100, h: 50 }], 6);
  expect([centered.x, centered.y, centered.guides]).toEqual([150, 10, []]);
  expect([...centered.gaps].sort((m, n) => m.from - n.from)).toEqual([{ axis: "x", from: 100, to: 150, at: 30 }, { axis: "x", from: 250, to: 300, at: 30 }]);
  expect([...centered.targets].sort()).toEqual([0, 1]);
  const matched = snap({ x: 297, y: 10, w: 100, h: 50 }, [a, { x: 150, y: 0, w: 100, h: 50 }], 6);
  expect([matched.x, matched.gaps.length]).toEqual([300, 2]);
  const right = snap({ x: 345, y: 10, w: 100, h: 50 }, [a, { x: 150, y: 0, w: 100, h: 50 }, { x: 500, y: 0, w: 100, h: 50 }], 6);
  expect([right.x, right.gaps.map(gap => gap.at)]).toEqual([350, [30, 30]]);
});

test("tidy straightens near rows and columns, leaves lone and overlapping cards and staircases, and is idempotent", () => {
  const card = (x: number, y: number) => ({ x, y, w: 280, h: 200 });
  const rects = new Map([["a", card(0, 0)], ["b", card(320, 30)], ["c", card(16, 300)], ["lone", card(1000, 1000)], ["p", card(2000, 2000)], ["q", card(2020, 2020)]]);
  const moved = tidy(rects, [...rects.keys()]);
  expect(moved).toEqual(new Map([["b", [320, 0]], ["c", [0, 300]]]));
  for (const [id, [x, y]] of moved) rects.set(id, { ...rects.get(id)!, x, y });
  expect(tidy(rects, [...rects.keys()]).size).toBe(0);
  const stairs = new Map([["s", card(0, 0)], ["t", card(320, 40)], ["u", card(640, 80)]]);
  expect(tidy(stairs, [...stairs.keys()])).toEqual(new Map([["t", [320, 0]]]));
  const row = new Map([["s0", card(0, 0)], ["s1", card(320, 10)], ["s2", card(640, 20)], ["s3", card(960, 30)], ["z", card(640, -185)]]);
  expect(tidy(row, [...row.keys()])).toEqual(new Map([["s0", [0, 10]]]));
  const chain = new Map([["a", card(0, 50)], ["b", card(320, 54)], ["c", card(640, 60)], ["d", card(960, 102)], ["e", card(1280, 150)]]);
  expect(tidy(chain, [...chain.keys()])).toEqual(new Map([["a", [0, 54]], ["c", [640, 54]], ["d", [960, 54]], ["e", [1280, 54]]]));
});

test("curve runs border to border, bows around a card in between and keeps a clear preferred bow", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 }, b = { x: 400, y: 0, w: 100, h: 100 }, wall = { x: 200, y: 0, w: 100, h: 100 };
  const clear = curve(a, b), around = curve(a, b, [wall]);
  expect(clear.start[0]).toBeCloseTo(100);
  expect(clear.end[0]).toBeCloseTo(400);
  expect(clear.mid[1]).toBeLessThan(112);
  expect(around.mid[1] > 112 || around.mid[1] < -12).toBe(true);
  expect([curve(a, b, [wall], -2).bow, curve(a, b, [wall], -1).bow]).toEqual([-2, around.bow]);
});

test("sections, yaml and profiles parse from one remote dump", () => {
  const dump = [
    "noise", "\u001enow\n1000",
    "\u001eprofile ops\ndescription: >\n  Runs the\n  ops desk\n",
    "\u001emodel ops\n  default: \"gpt-5\"\n  provider: openai",
    "\u001efiles ops\n{\"skills\":[[\"deploy\",\"devops\",\"Ship it\"]],\"jobs\":[{\"id\":\"j1\",\"name\":\"\",\"schedule\":\"0 9 * * *\",\"enabled\":1}]}",
    "\u001eprofile qa\n",
    "\u001egraph default\n{\"handoffs\":[[\"ops\",\"qa\",3],[\"qa\",\"ops\",2],[\"ops\",\"ghost\",9]],\"comments\":[[\"qa\",\"ops\",4]],\"links\":[[\"ops\",\"qa\",1]],\"load\":[[\"qa\",\"triage\",2]],\"done\":[[\"ops\",4]]}",
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
  expect(snapshot.edges).toEqual([{ a: "ops", b: "qa", handoffs: 5, comments: 4, links: 1 }]);
});

test("model catalog parses and setModel writes provider then model via the CLI", async () => {
  const sent: string[] = [];
  const reply = (stdout: string) => ({ run: async (_alias: string, command: { remoteCommand: string }) => {
    sent.push(Buffer.from(command.remoteCommand.match(/printf %s (\S+)/)![1]!, "base64").toString());
    return { transport: "connected", exitCode: 0, stdout, stderr: "", capExceeded: false };
  } }) as never;
  const catalog = await new HermesClient(reply("\u001ecache\n{\"anthropic\":{\"models\":[\"opus\",1]},\"x\":{\"fallback\":true}}")).models("h", "xia");
  expect(catalog).toEqual([["opus", "anthropic"]]);
  const client = new HermesClient(reply("\u001eok\n"));
  expect(await client.setModel("h", "xia", "m'; rm -rf ~", "anthropic")).toEqual({ ok: true });
  const script = sent.pop()!;
  expect(script.indexOf("config set model.provider")).toBeLessThan(script.indexOf("config set model.default"));
  expect(script).not.toContain("rm -rf");
  await expect(client.setModel("h", "../x", "m", "p")).rejects.toThrow();
  const count = sent.length;
  expect((await client.setModel("h", "xia", "--help", "p")).ok).toBe(false);
  expect((await client.setModel("h", "xia", "m", "-p")).ok).toBe(false);
  expect(sent.length).toBe(count);
  const failed = { run: async () => ({ transport: "connected", exitCode: 0, stdout: "\u001eok\n\u001e?3\n", stderr: "warn\nno such model", capExceeded: false }) } as never;
  expect(await new HermesClient(failed).setModel("h", "xia", "m", "p")).toEqual({ ok: false, message: "no such model" });
});
