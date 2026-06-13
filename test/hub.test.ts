import { describe, expect, it } from "vitest";
import { RunHub } from "../src/server/hub.js";

describe("RunHub", () => {
  it("assigns monotonic ids and bounds the replay buffer", () => {
    const hub = new RunHub(3); // retain only the 3 most recent
    for (let i = 0; i < 10; i++) hub.publish("s", "log", { i });

    const seen: number[] = [];
    hub.subscribe("s", (m) => seen.push(m.id)); // replays the retained buffer
    // Older messages were dropped, but ids stayed monotonic.
    expect(seen).toEqual([7, 8, 9]);
  });

  it("does not create a channel when subscribing to an unknown session", () => {
    const hub = new RunHub();
    const unsub = hub.subscribe("ghost", () => {
      throw new Error("listener should not fire");
    });
    unsub();
    expect(hub.has("ghost")).toBe(false);
  });

  it("forget releases the channel", () => {
    const hub = new RunHub();
    hub.publish("s", "log", {});
    expect(hub.has("s")).toBe(true);
    hub.forget("s");
    expect(hub.has("s")).toBe(false);
  });
});
