import { expect, test } from "bun:test";
import { dropMove, HermesClient, parseProfiles, yamlField } from "../src/hermes/data";
import { curve, snap } from "../src/hermes/geometry";
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
});

test("dropMove maps lanes to CLI verbs", () => {
  expect(dropMove("running", "done")).toBe("complete");
  expect(dropMove("done", "blocked")).toBeNull();
  expect(dropMove("blocked", "ready")).toBe("unblock");
  expect(dropMove("triage", "ready")).toBe("promote");
  expect(dropMove("running", "ready")).toBeNull();
  expect(dropMove("todo", "review")).toBeNull();
});
