// The family and group stays (3 bedrooms for 6, the entire Magic Villa for 10) as the public
// pages, llms.txt and the structured data describe them: every number those texts state must
// still be what rooms.ts and the booking catalogue say, so a price or capacity change cannot
// leave an old figure behind in copy that is written out by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BlogBlock, BlogLinkItem } from "../../data/blog.ts";
import { landings } from "../../data/landings.ts";
import { getRoomBySlug, rooms } from "../../data/rooms.ts";
import { hasSeaView, resortJsonLd, roomJsonLd, wholeVillaOf } from "../structuredData.ts";
import { CATALOGUE, UNIT_NAMES, getCatalogueRoom, sharedUnits } from "./catalogue.ts";

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const thb = (n: number) => n.toLocaleString("en-US");

const tower = getRoomBySlug("tower-club-3br")!;
const island = getRoomBySlug("island-view-3br")!;
const tuxedo3 = getRoomBySlug("tuxedo-3br")!;
const villa = getRoomBySlug("magic-1-villa")!;

test("the group stays the copy describes: 3 bedrooms for 6 and the entire Magic Villa for 10", () => {
  for (const r of [tower, island, tuxedo3]) {
    assert.equal(r.bedrooms, 3, r.slug);
    assert.equal(r.guests, 6, r.slug);
  }
  assert.equal(Math.min(tower.priceThb, island.priceThb), 18000);
  assert.equal(tuxedo3.priceThb, 25000);
  assert.deepEqual([villa.bedrooms, villa.guests, villa.poolType, villa.priceThb], [5, 10, "4 private pools", 40000]);
  // Tower Club and Island View both use the Magic Seaview level: one of them per night.
  assert.deepEqual(sharedUnits("tower-club-3br", "island-view-3br"), ["SVL"]);
  assert.equal(getCatalogueRoom("tuxedo-3br")!.bookable, false, "copy says Tuxedo 3 bedrooms is on request");
  for (const slug of ["tower-club-3br", "island-view-3br", "magic-1-villa"]) {
    assert.equal(getCatalogueRoom(slug)!.bookable, true, `copy says ${slug} books online`);
  }
});

test("home and /rooms descriptions: true, and they name the group stays", () => {
  const layout = repoFile("src/app/layout.tsx");
  const descriptions = [...layout.matchAll(/"(Koh Samui villas and suites[^"]*)"/g)].map((m) => m[1]);
  assert.equal(descriptions.length, 2, "both engine variants");
  for (const d of descriptions) {
    assert.ok(d.length <= 160, `${d.length} characters: ${d}`);
    assert.match(d, /most with a private pool/);
    assert.match(d, new RegExp(`${tower.bedrooms}-bedroom stays for ${tower.guests} and the whole villa, ${villa.bedrooms} bedrooms, sleeps ${villa.guests}`));
  }
  assert.doesNotMatch(layout, /each with its own private pool/);
  const roomsPage = repoFile("src/app/rooms/page.tsx");
  assert.match(roomsPage, /const fromThb = Math\.min\(\.\.\.rooms\.map\(\(r\) => r\.priceThb\)\);/);
  assert.doesNotMatch(roomsPage, /฿4,000|every one with its own pool/);
});

test("one unit count everywhere: 2 villas, 5 private suites (Magic Villa's 4 plus the Tuxedo Seaview Unit)", () => {
  assert.match(repoFile("src/app/rooms/page.tsx"), />2 Villas, 5 Private Suites</);
  assert.match(repoFile("src/app/page.tsx"), /2 villas, 5 private suites/);
  assert.match(repoFile("public/llms.txt"), /2 private pool villas and 5 private suites/);
  assert.equal(Object.keys(UNIT_NAMES).length, 6, "Magic Villa's 4 suites + the Tuxedo villa + its Seaview Unit");
});

test("llms.txt: the stays table matches the catalogue row by row, and every language page is linked", () => {
  const llms = repoFile("public/llms.txt").replaceAll("\r\n", "\n");
  for (const r of CATALOGUE) {
    const row = `| [${r.name}](https://magicsamui.com/rooms/${r.slug}) | ${r.bedrooms} | ${r.maxGuests} | ${r.hasPool ? "Yes" : "No"} | ${thb(r.referencePriceThb)} | ${r.bookable ? "Online" : "On request"} |`;
    assert.ok(llms.includes(row), `row for ${r.slug}`);
  }
  assert.match(llms, /## Families and groups/);
  assert.match(llms, /3 bedrooms for 6 guests, from 18,000 THB/);
  assert.match(llms, /The entire Magic Villa: 5 bedrooms, 4 private pools, up to 10 guests, from\s+40,000 THB/);
  for (const code of Object.keys(landings)) assert.ok(llms.includes(`(https://magicsamui.com/${code})`), code);
});

test("blog posts: the Where to Stay sections link real pages and state the room data", () => {
  for (const slug of ["koh-samui-villas-for-large-groups", "family-friendly-villas-in-koh-samui-accommodations-for-all-ages"]) {
    const post: { blocks: BlogBlock[] } = JSON.parse(repoFile(`src/data/blog-posts/${slug}.json`));
    const at = post.blocks.findIndex((b) => b.text === "Where to Stay with Us");
    assert.ok(at > 0, slug);
    const links = post.blocks
      .slice(at)
      .flatMap((b) => b.items ?? [])
      .filter((i): i is BlogLinkItem => typeof i === "object");
    assert.deepEqual(
      links.map((l) => l.href),
      ["/rooms/magic-1-villa", "/rooms/tower-club-3br", "/rooms/island-view-3br", "/rooms/tuxedo-3br", "/booking"],
      slug,
    );
    for (const link of links.filter((l) => l.href.startsWith("/rooms/"))) {
      const r = getRoomBySlug(link.href.slice("/rooms/".length))!;
      assert.ok(`${link.label} ${link.text}`.includes(`${r.bedrooms} bedrooms`), `${slug}: ${r.slug} bedrooms`);
      assert.match(link.text ?? "", new RegExp(`(for|sleeps) ${r.guests}\\b`), `${slug}: ${r.slug} guests`);
      assert.ok((link.text ?? "").includes(`from ฿${thb(r.priceThb)} a night`), `${slug}: ${r.slug} price`);
    }
  }
});

test("language pages: the entire Magic Villa card states the villa's real size", () => {
  for (const t of Object.values(landings)) {
    assert.ok(t.familyText.includes("{price}"), t.code);
    for (const n of [villa.bedrooms, 4, villa.guests]) {
      assert.match(t.familyText, new RegExp(`(^|\\D)${n}(\\D|$)`), `${t.code}: ${n}`);
    }
  }
});

test("structured data: bedrooms, guests, pools and sea view per stay, whole villas as a House", () => {
  for (const room of rooms) {
    const ld = JSON.parse(JSON.stringify(roomJsonLd(room)));
    assert.equal(ld.numberOfBedrooms, room.bedrooms, room.slug);
    assert.equal(ld.occupancy.maxValue, room.guests, room.slug);
    assert.equal(ld.offers.price, room.priceThb, room.slug);
    const features = (ld.amenityFeature ?? []).map((f: { name: string; value: boolean }) => {
      assert.equal(f.value, true);
      return f.name;
    });
    assert.equal(features.includes("Private pool"), room.hasPool !== false, `${room.slug}: pool`);
    assert.equal(features.includes("Sea view"), hasSeaView(room), `${room.slug}: sea view`);
    assert.equal(ld["@type"], ["magic-1-villa", "tuxedo-3br"].includes(room.slug) ? "House" : "HotelRoom", room.slug);
    assert.equal(ld.aggregateRating, undefined);
    assert.equal(ld.review, undefined);
  }
  assert.deepEqual(rooms.filter((r) => r.hasPool === false).map((r) => r.slug).sort(), ["garden-suite", "tuxedo-seaview-unit"]);
  // Every unit's own copy (or Cloudbeds name) says sea view today; a new unit needs a deliberate look.
  assert.equal(rooms.filter(hasSeaView).length, rooms.length);
  assert.equal(wholeVillaOf("magic-1-villa")?.slug, "magic-villa");
  assert.equal(wholeVillaOf("tuxedo-3br")?.slug, "tuxedo");
  assert.equal(wholeVillaOf("tuxedo"), undefined, "the 2-bedroom villa leaves the Seaview Unit to others");

  const resort = JSON.parse(JSON.stringify(resortJsonLd()));
  assert.equal(resort.numberOfRooms, 6);
  assert.equal(resort.priceRange, "฿3,000–฿40,000");
  assert.match(resort.description, /3-bedroom stays for 6 and the entire Magic Villa: 5 bedrooms, 4 private pools, up to 10 guests/);
  assert.equal(resort.aggregateRating, undefined);
});
