import { describe, expect, it } from "vite-plus/test";
import { parseProviderLoginCode, parseProviderLoginUrl } from "./providerLogin.ts";

describe("parseProviderLoginUrl", () => {
  it("extracts the first http(s) URL", () => {
    expect(
      parseProviderLoginUrl(
        "Open this URL to continue: https://auth.openai.com/device?x=1 then wait",
      ),
    ).toBe("https://auth.openai.com/device?x=1");
  });

  it("strips trailing punctuation that hugs the URL", () => {
    expect(parseProviderLoginUrl("Visit (https://example.com/verify).")).toBe(
      "https://example.com/verify",
    );
  });

  it("sees through ANSI color codes", () => {
    expect(parseProviderLoginUrl("[36mhttps://claude.ai/oauth[0m")).toBe(
      "https://claude.ai/oauth",
    );
  });

  it("returns undefined when no URL is present yet", () => {
    expect(parseProviderLoginUrl("Starting login...")).toBeUndefined();
  });
});

describe("parseProviderLoginCode", () => {
  it("extracts an XXXX-XXXX device code", () => {
    expect(parseProviderLoginCode("Your code is ABCD-1234, enter it in the browser")).toBe(
      "ABCD-1234",
    );
  });

  it("uppercases the code", () => {
    expect(parseProviderLoginCode("code: abcd-efgh")).toBe("ABCD-EFGH");
  });

  it("does not match a code embedded in a longer token", () => {
    expect(parseProviderLoginCode("xABCD-1234y")).toBeUndefined();
  });

  it("returns undefined when there is no device code (e.g. claude flow)", () => {
    expect(parseProviderLoginCode("Paste the token you copied from the browser")).toBeUndefined();
  });
});
