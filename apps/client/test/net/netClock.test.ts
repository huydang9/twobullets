import { describe, expect, it } from "vitest";
import { NetClock } from "../../src/net/NetClock";
import { parseNetParam } from "../../src/net/handshake";

describe("NetClock", () => {
  it("ticks nothing before start, then carries a 500 ms hitch's backlog without losing ticks (R4)", () => {
    const clock = new NetClock();
    expect(clock.advance(1)).toBe(0);
    clock.start(1000);
    let simulated = 0;
    const run = (seconds: number) => {
      for (let n = clock.advance(seconds); n > 0; n--) {
        expect(clock.nextTick()).toBe(1000 + simulated);
        simulated++;
      }
    };
    run(0.51);
    expect(simulated).toBe(5);
    expect(clock.backlogTicks).toBe(25);
    for (let i = 0; i < 10; i++) run(0);
    expect(simulated).toBe(30);
    expect(clock.currentTick).toBe(1030);
  });

  it("resync re-aligns the tick number", () => {
    const clock = new NetClock();
    clock.start(10);
    clock.advance(0.2);
    clock.resync(500);
    expect(clock.currentTick).toBe(500);
    expect(clock.nextTick()).toBe(500);
  });
});

describe("parseNetParam", () => {
  it("derives the match path and the dev token endpoint", () => {
    expect(parseNetParam("ws://localhost:7350/m/local")).toEqual({ wsUrl: "ws://localhost:7350/m/local", tokenUrl: "http://localhost:7350/dev/token" });
    expect(parseNetParam("ws://localhost:7350")).toEqual({ wsUrl: "ws://localhost:7350/m/local", tokenUrl: "http://localhost:7350/dev/token" });
    expect(parseNetParam("wss://m1.tbgs.net/m/abc").tokenUrl).toBe("https://m1.tbgs.net/dev/token");
  });
});
