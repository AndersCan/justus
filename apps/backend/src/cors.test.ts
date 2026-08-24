import { describe, it, expect } from "vite-plus/test";
import { classifyOrigin, isLoopbackHost } from "./cors";

describe("isLoopbackHost", () => {
  it("accepts localhost / 127.0.0.1 / ::1 and *.localhost", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("app.localhost")).toBe(true);
  });

  it("rejects private and public hosts", () => {
    expect(isLoopbackHost("evil.example.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe("classifyOrigin", () => {
  it("allows requests with no Origin header (no cross-origin read to defend)", () => {
    const v = classifyOrigin(undefined);
    expect(v.allowed).toBe(true);
    expect(v.corsOrigin).toBeUndefined();
  });

  it("reflects loopback Origins and only those", () => {
    for (const o of ["http://127.0.0.1:8080", "http://localhost:5173", "https://[::1]:9000"]) {
      const v = classifyOrigin(o);
      expect(v.allowed).toBe(true);
      expect(v.corsOrigin).toBe(o);
    }
  });

  it("forbids and withholds CORS for cross-origin Origins", () => {
    const v = classifyOrigin("https://evil.example.com");
    expect(v.allowed).toBe(false);
    expect(v.corsOrigin).toBeUndefined();
  });

  it("takes the first of multiple Origin values (defensive)", () => {
    const v = classifyOrigin(["http://127.0.0.1:8080", "https://evil.com"]);
    expect(v.allowed).toBe(true);
    expect(v.corsOrigin).toBe("http://127.0.0.1:8080");
  });
});
