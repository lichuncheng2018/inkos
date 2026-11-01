import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCloudLegadoBookSource,
  buildCloudLegadoBookSourceFile,
  buildLegadoChapterFile,
  phoneLegadoSourceUrl,
} from "../publish/phone-legado.js";
import { buildPhoneReaderHtml, phoneReaderPublicUrl } from "../publish/phone-reader-html.js";
import { loadPhoneSyncConfig } from "../publish/phone-sync-config.js";

describe("phone reader", () => {
  const previous = {
    url: process.env.INKOS_SUPABASE_URL,
    publishable: process.env.INKOS_SUPABASE_PUBLISHABLE_KEY,
    service: process.env.INKOS_SUPABASE_SERVICE_ROLE_KEY,
  };

  afterEach(() => {
    restoreEnv("INKOS_SUPABASE_URL", previous.url);
    restoreEnv("INKOS_SUPABASE_PUBLISHABLE_KEY", previous.publishable);
    restoreEnv("INKOS_SUPABASE_SERVICE_ROLE_KEY", previous.service);
  });

  it("builds a public reader URL from the storage object", () => {
    expect(phoneReaderPublicUrl("https://example.supabase.co/", "xiuxian-also-science")).toBe(
      "https://example.supabase.co/storage/v1/object/public/inkos-reader/index.html#xiuxian-also-science",
    );
  });

  it("builds a Legado network-import URL in the same JSON shape as the LAN source", () => {
    expect(phoneLegadoSourceUrl("https://example.supabase.co/")).toBe(
      "https://example.supabase.co/storage/v1/object/public/inkos-reader/legado.json",
    );
    const source = buildCloudLegadoBookSource({
      supabaseUrl: "https://example.supabase.co",
    });
    expect(source.bookSourceUrl).toBe(
      "https://example.supabase.co/storage/v1/object/public/inkos-reader/legado",
    );
    expect(source.searchUrl).toBe(
      "https://example.supabase.co/storage/v1/object/public/inkos-reader/legado/books.json",
    );
    expect(source.exploreUrl).toContain("作品::");
    expect(JSON.stringify(source)).toContain("$.books[*]");
    expect(JSON.stringify(source)).toContain("$.chapters[*]");
    expect(JSON.stringify(source)).toContain("@json:$.content");
    expect(JSON.stringify(source)).not.toContain("service_role");
    expect(JSON.stringify(source)).not.toContain("apikey");
    expect(JSON.stringify(source)).not.toContain("{{$.");
    expect(buildCloudLegadoBookSourceFile({ supabaseUrl: "https://example.supabase.co" }).startsWith("[{")).toBe(true);
    expect(buildLegadoChapterFile("雨水落在旧码头。")).toBe(JSON.stringify({ content: "雨水落在旧码头。" }));
  });

  it("embeds PostgREST chapter reads, not the service role", () => {
    const html = buildPhoneReaderHtml({
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
    });
    expect(html).toContain("inkos_chapters?book_id=eq.");
    expect(html).toContain("sb_publishable_test");
    expect(html).not.toContain("service_role");
  });

  it("loads config from env, then from .inkos/supabase.json", async () => {
    delete process.env.INKOS_SUPABASE_URL;
    delete process.env.INKOS_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.INKOS_SUPABASE_SERVICE_ROLE_KEY;
    expect(await loadPhoneSyncConfig("/tmp/missing-inkos-phone-sync")).toBeNull();

    const root = await mkdtemp(join(tmpdir(), "inkos-phone-"));
    try {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await writeFile(join(root, ".inkos", "supabase.json"), JSON.stringify({
        url: "https://file.supabase.co/",
        publishableKey: "pub-file",
        serviceRoleKey: "srv-file",
      }));
      expect(await loadPhoneSyncConfig(root)).toEqual({
        url: "https://file.supabase.co",
        publishableKey: "pub-file",
        serviceRoleKey: "srv-file",
      });

      process.env.INKOS_SUPABASE_URL = "https://env.supabase.co";
      process.env.INKOS_SUPABASE_PUBLISHABLE_KEY = "pub-env";
      process.env.INKOS_SUPABASE_SERVICE_ROLE_KEY = "srv-env";
      expect(await loadPhoneSyncConfig(root)).toEqual({
        url: "https://env.supabase.co",
        publishableKey: "pub-env",
        serviceRoleKey: "srv-env",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
