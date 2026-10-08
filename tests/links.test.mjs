// Links from the API open only on https colitu.com hosts.
import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.chrome ??= { runtime: { getManifest: () => ({ version: "0" }) }, storage: { local: {} } };
const { isColituUrl } = await import("../src/lib/api.js");

test("only https colitu.com links are accepted", () => {
  for (const ok of ["https://colitu.com/link?c=1", "https://app.colitu.com/device", "https://docs.colitu.com/"]) {
    assert.equal(isColituUrl(ok), true, ok);
  }
  for (const bad of ["http://colitu.com/", "https://colitu.com.evil.example/", "https://evilcolitu.com/",
    "https://user:pw@colitu.com/", "javascript:alert(1)", "not a url", "", undefined]) {
    assert.equal(isColituUrl(bad), false, String(bad));
  }
});
