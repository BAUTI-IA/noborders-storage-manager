// Fixture tests for the @mention logic behind dispatch notes and the
// notifications bell (src/notificationsData.js).
// Run: node scripts/test-notifications-data.mjs (npm test picks it up).
import assert from "node:assert/strict";
import {
  personLabel, mentionAliases, mentionPattern, findMentionedIds, composeNote,
  mentionQuery, mentionSuggestions, applyMention, badgeText,
} from "../src/notificationsData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

const team = [
  { id: "u-yancy", full_name: "Yancy Perez", email: "yancy@nb.com" },
  { id: "u-seba", full_name: "", email: "sebastian.ramonc@nb.com" },
  { id: "u-ana", full_name: "Ana", email: "ana@nb.com" },
  { id: "u-anag", full_name: "Ana Gomez", email: "agomez@nb.com" },
  { id: "u-bauti", full_name: "Bautista", email: "b@nb.com" },
];

t("label: full name, else the email's local part", () => {
  assert.equal(personLabel(team[0]), "Yancy Perez");
  assert.equal(personLabel(team[1]), "sebastian.ramonc");
  assert.equal(personLabel({}), "user");
});

t("aliases: a unique first name reaches the person, a shared one does not", () => {
  const a = mentionAliases(team);
  assert.equal(a.get("yancy")?.id, "u-yancy", "@Yancy should reach Yancy Perez");
  assert.equal(a.get("ana")?.id, "u-ana", "the full label 'Ana' belongs to Ana, not Ana Gomez");
  assert.equal(a.get("ana gomez")?.id, "u-anag");
});

t("typed mentions: found case-insensitively, once each, in order", () => {
  assert.deepEqual(findMentionedIds("@yancy confirm customer, cc @Bautista and @Yancy again", team), ["u-yancy", "u-bauti"]);
  assert.deepEqual(findMentionedIds("@Yancy Perez call them", team), ["u-yancy"]);
  assert.deepEqual(findMentionedIds("@sebastian.ramonc pads?", team), ["u-seba"]);
});

t("typed mentions: a longer word or an email is not a mention", () => {
  assert.deepEqual(findMentionedIds("@Anabella is the customer", team), []);
  assert.deepEqual(findMentionedIds("write to yancy@nb.com", team), []);
  assert.deepEqual(findMentionedIds("@Ana Gomez and @Ana", team), ["u-anag", "u-ana"]);
});

t("render split alternates text and names (one capture group)", () => {
  const parts = "Hi @Yancy, call @Ana Gomez".split(mentionPattern(team));
  assert.deepEqual(parts, ["Hi ", "Yancy", ", call ", "Ana Gomez", ""]);
  assert.equal(mentionPattern([]), null);
});

t("compose: chips are written in front, typed ones are not doubled", () => {
  const r = composeNote("  @Yancy confirm customer ", team, ["u-yancy", "u-bauti"], "u-seba");
  assert.equal(r.stored, "@Bautista @Yancy confirm customer");
  assert.deepEqual(r.taggedIds.sort(), ["u-bauti", "u-yancy"]);
});

t("compose: no tags leaves the note alone; the author never alerts themself", () => {
  assert.deepEqual(composeNote("Pads loaded", team, []), { stored: "Pads loaded", taggedIds: [] });
  const r = composeNote("note to self @sebastian.ramonc", team, [], "u-seba");
  assert.deepEqual(r.taggedIds, []);
});

t("autocomplete query: only a trailing mention after a space or at the start", () => {
  assert.equal(mentionQuery("Call @Yan", team), "Yan");
  assert.equal(mentionQuery("@", team), "");
  assert.equal(mentionQuery("mail yancy@nb", team), null);
  assert.equal(mentionQuery("no mention here", team), null);
  assert.equal(mentionQuery("@Yancy P", team), "Yancy P", "still completing a two-word name");
  assert.equal(mentionQuery("@Yan confirm", team), null, "a space after a partial name ends it");
  assert.equal(mentionQuery("@Yancy Perez ", team), null, "a completed mention closes the list");
});

t("suggestions: prefix of the name or any word in it, without the author", () => {
  assert.deepEqual(mentionSuggestions("an", team, "u-seba").map(p => p.id), ["u-ana", "u-anag"]);
  assert.deepEqual(mentionSuggestions("gom", team).map(p => p.id), ["u-anag"]);
  assert.deepEqual(mentionSuggestions("seb", team, "u-seba"), []);
  assert.equal(mentionSuggestions("", team, "u-seba").length, 4);
  assert.deepEqual(mentionSuggestions(null, team), []);
});

t("suggestions: hidden once the query already names the only match", () => {
  assert.deepEqual(mentionSuggestions("Yancy", team), []);
  assert.deepEqual(mentionSuggestions("Bautista", team), []);
  assert.equal(mentionSuggestions("Ana", team).length, 2, "'Ana' still offers Ana Gomez");
});

t("apply: the half-typed mention becomes the full label", () => {
  assert.equal(applyMention("Confirm with @yan", team[0]), "Confirm with @Yancy Perez ");
  const done = applyMention("@", team[4]);
  assert.equal(done, "@Bautista ");
  assert.deepEqual(findMentionedIds(done, team), ["u-bauti"]);
});

t("badge text caps at 9+", () => {
  assert.equal(badgeText(0), "0");
  assert.equal(badgeText(7), "7");
  assert.equal(badgeText(12), "9+");
});
