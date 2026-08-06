import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_TOOLS,
  assistantToolDefinitions,
  confirmationQuestion,
  findAssistantTool,
  parseToolArguments,
} from "../../features/assistant/tools";

test("exposes every tool to Ollama with a unique name and a valid schema", () => {
  const definitions = assistantToolDefinitions();
  const names = definitions.map((definition) => definition.function.name);

  assert.equal(definitions.length, ASSISTANT_TOOLS.length);
  assert.equal(new Set(names).size, names.length);
  for (const definition of definitions) {
    assert.equal(definition.type, "function");
    assert.ok(definition.function.description.length > 10);
    assert.equal(definition.function.parameters.type, "object");
    assert.ok(Array.isArray(definition.function.parameters.required));
  }
});

test("every tool that changes something asks for a confirmation", () => {
  const confirming = ASSISTANT_TOOLS.filter((tool) => confirmationQuestion(tool, {}));

  assert.deepEqual(confirming.map((tool) => tool.name), [
    "mac_empty_trash",
    "calendar_create_event",
    "gmail_archive_mails",
    "gmail_trash_mails",
  ]);
  assert.equal(
    confirmationQuestion(confirming[0], {}),
    "Der Papierkorb wird endgültig geleert. Fortfahren?",
  );
});

test("a mail confirmation says how wide the net is", () => {
  const archive = findAssistantTool("gmail_archive_mails");
  const trash = findAssistantTool("gmail_trash_mails");
  assert.ok(archive && trash);

  assert.equal(
    confirmationQuestion(archive, parseToolArguments(archive, { query: "Newsletter" })),
    "Ich nehme alle Mails zu „Newsletter“ aus dem Posteingang. Fortfahren?",
  );
  assert.equal(
    confirmationQuestion(trash, parseToolArguments(trash, { date: "2026-08-05" })),
    "Ich lege alle Mails vom 2026-08-05 in den Papierkorb. Fortfahren?",
  );
});

test("the calendar confirmation names the appointment the user is about to get", () => {
  const create = findAssistantTool("calendar_create_event");
  assert.ok(create);

  assert.equal(
    confirmationQuestion(create, parseToolArguments(create, { title: "Zahnarzt", start: "2026-03-14T15:00" })),
    "Ich trage „Zahnarzt“ am 14.03.2026 um 15:00 Uhr in deinen Google-Kalender ein. Fortfahren?",
  );
  // Without a time the question stays honest instead of inventing one.
  assert.match(
    confirmationQuestion(create, parseToolArguments(create, { title: "Zahnarzt" })) ?? "",
    /^Ich trage „Zahnarzt“ in deinen Google-Kalender ein\./u,
  );
});

test("no tool can send mail or delete it for good", () => {
  const mailTools = ASSISTANT_TOOLS.filter((tool) => tool.name.startsWith("gmail_"));

  assert.deepEqual(mailTools.map((tool) => tool.name), [
    "gmail_check_inbox",
    "gmail_search_mails",
    "gmail_read_mail",
    "gmail_archive_mails",
    "gmail_trash_mails",
  ]);
  // Nothing in the catalogue may even be named after sending or answering.
  assert.equal(
    ASSISTANT_TOOLS.some((tool) => /send|reply|compose|forward|antwort|weiterleit/iu.test(tool.name)),
    false,
  );
  for (const name of ["gmail_check_inbox", "gmail_search_mails", "gmail_read_mail"]) {
    assert.equal(confirmationQuestion(findAssistantTool(name)!, {}), null, `${name} only reads`);
  }
  // Trashing is recoverable and the description has to say so, because it is spoken to the model.
  assert.match(findAssistantTool("gmail_trash_mails")!.description, /30 Tage lang wiederherstellbar/u);
  assert.match(findAssistantTool("gmail_trash_mails")!.description, /Endgültig löschen kannst du nichts\./u);
});

test("only a tool that returns raw material lets the model speak for it", () => {
  // Local results are finished German sentences; the text of a mail is not.
  const byModel = ASSISTANT_TOOLS.filter((tool) => tool.spoken === "model");

  assert.deepEqual(byModel.map((tool) => tool.name), ["gmail_read_mail"]);
});

test("every tool that touches this Mac routes through the local action layer", () => {
  for (const tool of ASSISTANT_TOOLS) {
    if (tool.target === "local") assert.ok(tool.path?.startsWith("/"), `${tool.name} has no local path`);
    else assert.equal(tool.path, undefined);
  }
});

test("coerces the loose arguments a small model produces", () => {
  const volume = findAssistantTool("mac_set_volume");
  const play = findAssistantTool("spotify_play");
  const news = findAssistantTool("get_tech_news");
  assert.ok(volume && play && news);

  assert.deepEqual(parseToolArguments(volume, { percent: "70 Prozent" }), { percent: 70 });
  assert.deepEqual(parseToolArguments(volume, { percent: 240 }), { percent: 100 });
  assert.deepEqual(parseToolArguments(volume, { percent: -20 }), { percent: 0 });
  // A value without digits must not silently mute the Mac.
  assert.deepEqual(parseToolArguments(volume, { percent: "laut" }), {});
  assert.deepEqual(parseToolArguments(volume, {}), {});
  assert.deepEqual(parseToolArguments(news, { limit: 12 }), { limit: 5 });
  assert.deepEqual(parseToolArguments(play, { query: "  Bohemian   Rhapsody ", type: "ALBUM" }), {
    query: "Bohemian Rhapsody",
    type: "album",
  });
  assert.deepEqual(parseToolArguments(play, { query: "Queen", type: "unbekannt" }), {
    query: "Queen",
    type: "track",
  });
});

test("coerces the arguments of the new account tools", () => {
  const agenda = findAssistantTool("calendar_agenda");
  const create = findAssistantTool("calendar_create_event");
  const inbox = findAssistantTool("gmail_check_inbox");
  const search = findAssistantTool("chrome_search");
  assert.ok(agenda && create && inbox && search);

  assert.deepEqual(parseToolArguments(agenda, { range: "WEEK" }), { range: "week" });
  assert.deepEqual(parseToolArguments(agenda, { range: "übermorgen" }), { range: "today" });
  // Minutes are not a percentage, so a two-hour meeting survives unclamped.
  assert.deepEqual(parseToolArguments(create, { title: "Review", start: "2026-03-14T15:00", duration: 120 }), {
    title: "Review",
    start: "2026-03-14T15:00",
    duration: 120,
    location: "",
  });
  assert.equal(parseToolArguments(create, { title: "Review", start: "2026-03-14T15:00" }).duration, 60);
  assert.deepEqual(parseToolArguments(inbox, { limit: 99 }), { limit: 5 });
  assert.deepEqual(parseToolArguments(inbox, {}), {});
  // A question about one day carries no search term, so the day has to reach the action layer.
  const mails = findAssistantTool("gmail_search_mails");
  assert.ok(mails);
  assert.deepEqual(parseToolArguments(mails, { date: "2026-08-05" }), { query: "", date: "2026-08-05" });
  assert.deepEqual(parseToolArguments(search, { query: "  neue   Mac   Modelle " }), { query: "neue Mac Modelle" });
});

test("drops arguments for tools that take none", () => {
  const pause = findAssistantTool("spotify_pause");
  assert.ok(pause);
  assert.deepEqual(parseToolArguments(pause, { percent: 40, path: "/etc" }), {});
});

test("unknown tool names never resolve", () => {
  assert.equal(findAssistantTool("rm_rf_home"), null);
  assert.equal(findAssistantTool(""), null);
});
