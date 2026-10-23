import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { DashboardSshTunnel } from "../src/ui/dashboard-ssh-tunnel";
import { authenticatedProbe, gate, LoopbackTransport } from "./dashboard-tunnel-fixture";

describe("dashboard connection ownership using real loopback children", () => {
  test("two leaves share a tunnel until the last release", async () => {
    // Given
    const transport = new LoopbackTransport();
    const owner = new DashboardSshTunnel(authenticatedProbe, transport);
    const first = owner.acquire("fixture");
    const second = owner.acquire("fixture");
    try {
      const a = await first.ready;
      const b = await second.ready;
      expect(a).toBe(b);
      expect(transport.children).toHaveLength(1);
      // When
      await first.release();
      await authenticatedProbe(b);
      await second.release();
      // Then
      expect(b.signal.aborted).toBe(true);
      expect(transport.children[0]?.exitCode !== null || transport.children[0]?.signalCode !== null).toBe(true);
      await expect(fetch(b.baseUrl)).rejects.toThrow();
    } finally { await owner.dispose(); }
  });

  test("child death aborts a ready connection", async () => {
    // Given
    const transport = new LoopbackTransport();
    const owner = new DashboardSshTunnel(authenticatedProbe, transport);
    try {
      const lease = owner.acquire("fixture");
      const connection = await lease.ready;
      const aborted = once(connection.signal, "abort", { signal: AbortSignal.timeout(3000) });
      // When
      transport.children[0]?.kill("SIGKILL");
      await aborted;
      await lease.release();
      // Then
      expect(connection.signal.aborted).toBe(true);
      await expect(fetch(connection.baseUrl)).rejects.toThrow();
    } finally { await owner.dispose(); }
  });

  test("target invalidation rejects connecting leaves", async () => {
    // Given
    const transport = new LoopbackTransport();
    const entered = gate();
    const owner = new DashboardSshTunnel(async (connection) => {
      await authenticatedProbe(connection);
      entered.open();
      await once(connection.signal, "abort");
    }, transport);
    try {
      const lease = owner.acquire("old-target");
      const rejected = lease.ready.then(() => false, () => true);
      await entered.promise;
      // When
      await owner.invalidate("old-target");
      // Then
      expect(await rejected).toBe(true);
      expect(transport.children[0]?.signalCode).toBe("SIGTERM");
      await expect(fetch(`http://127.0.0.1:${transport.ports[0]}`)).rejects.toThrow();
    } finally { await owner.dispose(); }
  });

  test("unauthenticated open port cannot become ready", async () => {
    // Given
    const transport = new LoopbackTransport();
    const owner = new DashboardSshTunnel(async (connection) => {
      const response = await fetch(connection.baseUrl, { signal: connection.signal });
      if (response.status !== 200) throw new Error("Authentication rejected");
    }, transport);
    try {
      // When
      const lease = owner.acquire("fixture");
      // Then
      await expect(lease.ready).rejects.toThrow("Authentication rejected");
      await lease.release();
      await expect(fetch(`http://127.0.0.1:${transport.ports[0]}`)).rejects.toThrow();
    } finally { await owner.dispose(); }
  });

  test("last release during child launch waits for teardown", async () => {
    // Given
    const transport = new LoopbackTransport();
    const entered = gate();
    const owner = new DashboardSshTunnel(authenticatedProbe, { connect: (alias, signal) => {
      const connecting = transport.connect(alias, signal);
      entered.open();
      return connecting;
    } });
    try {
      const lease = owner.acquire("fixture");
      const rejected = lease.ready.then(() => false, () => true);
      await entered.promise;
      // When
      await lease.release();
      // Then
      expect(await rejected).toBe(true);
      expect(transport.children[0]?.signalCode).toBe("SIGTERM");
    } finally { await owner.dispose(); }
  });

  test("a pre-aborted acquisition never launches a child", async () => {
    // Given
    const transport = new LoopbackTransport();
    const owner = new DashboardSshTunnel(authenticatedProbe, transport);
    // When / Then
    expect(() => owner.acquire("fixture", AbortSignal.abort())).toThrow();
    expect(() => owner.acquire("-oProxyCommand=evil")).toThrow();
    expect(transport.children).toHaveLength(0);
    await owner.dispose();
  });

  test("one leaf cancellation preserves the other lease and target replacement changes generation", async () => {
    // Given
    const transport = new LoopbackTransport();
    const owner = new DashboardSshTunnel(authenticatedProbe, transport);
    const cancellation = new AbortController();
    const first = owner.acquire("fixture", cancellation.signal);
    const second = owner.acquire("fixture");
    try {
      const old = await first.ready;
      await second.ready;
      // When
      cancellation.abort();
      await first.release();
      await authenticatedProbe(old);
      await owner.invalidate("fixture");
      const replacement = owner.acquire("replacement");
      const current = await replacement.ready;
      // Then
      expect(old.signal.aborted).toBe(true);
      expect(current.generation).toBeGreaterThan(old.generation);
      expect(current.alias).toBe("replacement");
      expect(current.signal.aborted).toBe(false);
      await replacement.release();
      await second.release();
    } finally { await owner.dispose(); }
  });

  test("unload aborts authenticated requests and rejects later acquisitions", async () => {
    // Given
    const owner = new DashboardSshTunnel(authenticatedProbe, new LoopbackTransport());
    const lease = owner.acquire("fixture");
    const connection = await lease.ready;
    const aborted = once(connection.signal, "abort", { signal: AbortSignal.timeout(3000) });
    // When
    await owner.dispose();
    // Then
    await aborted;
    await expect(fetch(connection.baseUrl)).rejects.toThrow();
    expect(() => owner.acquire("fixture")).toThrow();
    await lease.release();
  });
});
