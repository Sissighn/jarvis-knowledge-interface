/**
 * The single source of truth for everything the voice assistant is allowed to do.
 * The model only ever sees the tools listed here, and irreversible ones carry the
 * German question that has to be answered before they may run.
 */
import type { AssistantToolTarget } from "./types";

type ToolArguments = Record<string, unknown>;

type JsonSchema = {
  type: "object";
  required: string[];
  properties: Record<string, unknown>;
};

export type AssistantTool = {
  name: string;
  target: AssistantToolTarget;
  /** Route below `/api/local` for tools that touch this Mac or Spotify. */
  path?: string;
  description: string;
  parameters: JsonSchema;
  /** Short German label for the visible transcript. */
  label: string;
  /**
   * Local results are finished German sentences and are spoken as they are. A tool that returns
   * raw material instead — the text of a mail, say — sets "model" so the answer gets condensed.
   */
  spoken?: "verbatim" | "model";
  /** Irreversible tools return the question the user has to confirm first. */
  confirmation?(args: ToolArguments): string;
  /** Normalizes whatever the model produced into safe arguments. */
  parse?(args: ToolArguments): ToolArguments;
};

const NO_ARGUMENTS: JsonSchema = { type: "object", required: [], properties: {} };

function readString(value: unknown, max = 200) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
}

function readPercent(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
  }
  // Text without a single digit is not a quiet zero, it is an unusable value.
  const digits = readString(value).replace(/[^\d.-]/gu, "");
  if (!/\d/u.test(digits)) return null;
  const numeric = Number(digits);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : null;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const candidate = readString(value).toLowerCase();
  return allowed.find((entry) => entry === candidate) ?? fallback;
}

/** Minutes are not a percentage: a two-hour meeting has to survive the clamp. */
function readMinutes(value: unknown, fallback = 60) {
  const numeric = typeof value === "number" ? value : Number(readString(value).replace(/[^\d]/gu, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(5, Math.min(720, Math.round(numeric)));
}

/**
 * Names what a mail command is about to hit. The confirmation can only repeat the criteria, not
 * the messages behind them, so it has to be unmistakable about how wide the net is.
 */
function mailScope(args: ToolArguments) {
  const query = readString(args.query, 200);
  const date = readString(args.date, 40);
  if (query && date) return `alle Mails zu „${query}“ vom ${date}`;
  if (query) return `alle Mails zu „${query}“`;
  if (date) return `alle Mails vom ${date}`;
  return "die betroffenen Mails";
}

const SPOKEN_MOMENT = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})/u;

/** Turns the machine timestamp of a new appointment into the question a person can answer. */
function spokenMoment(value: string) {
  const match = SPOKEN_MOMENT.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  return `am ${day.padStart(2, "0")}.${month.padStart(2, "0")}.${year} um ${hour.padStart(2, "0")}:${minute} Uhr`;
}

export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    name: "get_temperature",
    target: "dashboard",
    label: "Temperatur",
    description: "Verwenden bei Fragen zur aktuellen Temperatur oder Wetterlage jetzt. Nennt Temperatur, gefühlte Temperatur und aktuelles Wetter am eingestellten Ort. Nicht für den Regenzeitpunkt verwenden.",
    parameters: NO_ARGUMENTS,
  },
  {
    name: "get_rain_forecast",
    target: "dashboard",
    label: "Regenvorhersage",
    description: "Verwenden bei Fragen wie wann oder ob es regnet, Regenwahrscheinlichkeit oder ob ein Regenschirm nötig ist. Nennt die Regenprognose für heute und die nächsten Tage.",
    parameters: NO_ARGUMENTS,
  },
  {
    name: "get_tech_news",
    target: "dashboard",
    label: "Tech-News",
    description: "Verwenden für die wichtigsten Tech-News oder Technologie-Nachrichten des Tages. Liefert ausschließlich Meldungen aus dem aktuellen Morning Briefing.",
    parameters: {
      type: "object",
      required: [],
      properties: {
        limit: { type: "integer", description: "Wie viele Meldungen genannt werden sollen, 1 bis 5. Standard 5." },
      },
    },
    parse: (args) => ({ limit: Math.max(1, Math.min(5, readPercent(args.limit) ?? 5)) }),
  },
  {
    name: "get_words_of_the_day",
    target: "dashboard",
    label: "Wörter des Tages",
    description: "Verwenden bei Fragen nach Wörtern, Vokabeln oder Tech-Begriffen des Tages. Nennt die heutigen Begriffe mit kurzer Erklärung.",
    parameters: NO_ARGUMENTS,
  },
  {
    name: "get_dashboard_summary",
    target: "dashboard",
    label: "Dashboard-Zusammenfassung",
    description: "Verwenden nur für einen allgemeinen Tagesüberblick oder eine komplette Dashboard-Zusammenfassung. Enthält Wetter, Regen, Tech-News und Wörter des Tages; die Einzelwerkzeuge dann nicht zusätzlich aufrufen.",
    parameters: NO_ARGUMENTS,
  },
  {
    name: "spotify_play",
    target: "local",
    path: "/spotify/play",
    label: "Spotify abspielen",
    description: "Verwenden, wenn auf Spotify ein Lied, Künstler, Album oder eine Playlist abgespielt werden soll. query enthält den Namen ohne Füllwörter; type entspricht ausdrücklich track, artist, album oder playlist.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Der gesuchte Titel, Künstler, Albumname oder Playlistname." },
        type: {
          type: "string",
          enum: ["track", "artist", "album", "playlist"],
          description: "Art der Suche. Standard ist track.",
        },
      },
    },
    parse: (args) => ({
      query: readString(args.query, 120),
      type: readEnum(args.type, ["track", "artist", "album", "playlist"] as const, "track"),
    }),
  },
  {
    name: "spotify_pause",
    target: "local",
    path: "/spotify/pause",
    label: "Spotify pausieren",
    description: "Pausiert die laufende Spotify-Wiedergabe.",
    parameters: NO_ARGUMENTS,
  },
  {
    name: "spotify_resume",
    target: "local",
    path: "/spotify/resume",
    label: "Spotify fortsetzen",
    description: "Setzt die pausierte Spotify-Wiedergabe fort.",
    parameters: NO_ARGUMENTS,
  },
  {
    name: "spotify_next",
    target: "local",
    path: "/spotify/next",
    label: "Nächster Titel",
    description: "Springt zum nächsten Titel in Spotify.",
    parameters: NO_ARGUMENTS,
  },
  {
    name: "spotify_previous",
    target: "local",
    path: "/spotify/previous",
    label: "Vorheriger Titel",
    description: "Springt zum vorherigen Titel in Spotify.",
    parameters: NO_ARGUMENTS,
  },
  {
    name: "spotify_set_volume",
    target: "local",
    path: "/spotify/volume",
    label: "Spotify-Lautstärke",
    description: "Setzt ausschließlich die Spotify-Lautstärke auf einen genannten Prozentwert. Nicht für Mac- oder Systemlautstärke verwenden; ohne Prozentwert zuerst nachfragen.",
    parameters: {
      type: "object",
      required: ["percent"],
      properties: { percent: { type: "integer", description: "Lautstärke von 0 bis 100." } },
    },
    // An unusable value stays out, so the action layer rejects it instead of guessing.
    parse: (args) => {
      const percent = readPercent(args.percent);
      return percent === null ? {} : { percent };
    },
  },
  {
    name: "spotify_current_track",
    target: "local",
    path: "/spotify/current",
    label: "Aktueller Titel",
    description: "Nennt das Lied, das gerade auf Spotify läuft, mit Künstler und Album.",
    parameters: NO_ARGUMENTS,
  },
  {
    name: "mac_open_app",
    target: "local",
    path: "/mac/open-app",
    label: "Programm öffnen",
    description: "Öffnet ein freigegebenes Programm auf diesem Mac, zum Beispiel Spotify.",
    parameters: {
      type: "object",
      required: ["app"],
      properties: { app: { type: "string", description: "Name des Programms, zum Beispiel Spotify oder Safari." } },
    },
    parse: (args) => ({ app: readString(args.app, 60) }),
  },
  {
    name: "mac_set_volume",
    target: "local",
    path: "/mac/volume",
    label: "Systemlautstärke",
    description: "Setzt die Mac-Systemlautstärke auf einen genannten Prozentwert. Nicht für Spotify-Lautstärke verwenden; ohne Prozentwert zuerst nachfragen.",
    parameters: {
      type: "object",
      required: ["percent"],
      properties: { percent: { type: "integer", description: "Lautstärke von 0 bis 100." } },
    },
    parse: (args) => {
      const percent = readPercent(args.percent);
      return percent === null ? {} : { percent };
    },
  },
  {
    name: "mac_change_volume",
    target: "local",
    path: "/mac/volume-change",
    label: "Lautstärke ändern",
    description: "Ändert die Mac-Systemlautstärke relativ: lauter, leiser, stumm oder wieder hörbar. Nicht für Spotify verwenden.",
    parameters: {
      type: "object",
      required: ["direction"],
      properties: {
        direction: { type: "string", enum: ["up", "down", "mute", "unmute"], description: "Richtung der Änderung." },
      },
    },
    parse: (args) => ({ direction: readEnum(args.direction, ["up", "down", "mute", "unmute"] as const, "up") }),
  },
  {
    name: "mac_open_path",
    target: "local",
    path: "/mac/open-path",
    label: "Datei öffnen",
    description: "Öffnet eine Datei oder einen Ordner im persönlichen Benutzerordner, zum Beispiel den Downloads-Ordner.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", description: "Pfad im Benutzerordner, zum Beispiel ~/Downloads." } },
    },
    parse: (args) => ({ path: readString(args.path, 400) }),
  },
  {
    name: "mac_empty_trash",
    target: "local",
    path: "/mac/empty-trash",
    label: "Papierkorb leeren",
    description: "Leert den Papierkorb dieses Macs endgültig. Diese Aktion kann nicht rückgängig gemacht werden.",
    parameters: NO_ARGUMENTS,
    confirmation: () => "Der Papierkorb wird endgültig geleert. Fortfahren?",
  },
  {
    name: "calendar_agenda",
    target: "local",
    path: "/calendar/agenda",
    label: "Kalender",
    description: "Verwenden, um bestehende Google-Kalender-Termine für heute, morgen oder die nächsten sieben Tage anzusehen. Nicht zum Anlegen eines Termins verwenden.",
    parameters: {
      type: "object",
      required: [],
      properties: {
        range: {
          type: "string",
          enum: ["today", "tomorrow", "week"],
          description: "Zeitraum der Termine. Standard ist today.",
        },
      },
    },
    parse: (args) => ({ range: readEnum(args.range, ["today", "tomorrow", "week"] as const, "today") }),
  },
  {
    name: "calendar_create_event",
    target: "local",
    path: "/calendar/create-event",
    label: "Termin eintragen",
    description: "Verwenden nur zum Anlegen eines neuen Google-Kalender-Termins. Nur aufrufen, wenn Titel, Datum und eine ausdrücklich genannte Uhrzeit feststehen. Ohne Uhrzeit kein Werkzeug aufrufen, sondern nachfragen; niemals eine Uhrzeit schätzen. Es werden keine Gäste eingeladen und keine Einladungen verschickt.",
    parameters: {
      type: "object",
      required: ["title", "start"],
      properties: {
        title: { type: "string", description: "Worum es bei dem Termin geht, zum Beispiel Zahnarzt." },
        start: {
          type: "string",
          description: "Beginn als lokale Zeit im Format JJJJ-MM-TTTHH:MM. Nur eine ausdrücklich genannte oder zuvor bestätigte Uhrzeit verwenden; niemals schätzen.",
        },
        duration: { type: "integer", description: "Nur übergeben, wenn die Dauer ausdrücklich genannt wurde. Sonst weglassen; Standard ist 60 Minuten." },
        location: { type: "string", description: "Optionaler Ort des Termins." },
      },
    },
    parse: (args) => ({
      title: readString(args.title, 120),
      start: readString(args.start, 40),
      duration: readMinutes(args.duration),
      location: readString(args.location, 120),
    }),
    confirmation: (args) => {
      const title = readString(args.title, 120) || "Termin ohne Titel";
      const start = readString(args.start, 40);
      return start
        ? `Ich trage „${title}“ ${spokenMoment(start)} in deinen Google-Kalender ein. Fortfahren?`
        : `Ich trage „${title}“ in deinen Google-Kalender ein. Fortfahren?`;
    },
  },
  {
    name: "gmail_check_inbox",
    target: "local",
    path: "/gmail/inbox",
    label: "Posteingang",
    description: "Verwenden für einen Überblick über neue oder ungelesene Gmail-Nachrichten. Sagt Anzahl, Absender und Betreff der neuesten Mails. Nicht verwenden, um eine bestimmte Mail inhaltlich zu lesen.",
    parameters: {
      type: "object",
      required: [],
      properties: {
        limit: { type: "integer", description: "Wie viele Mails genannt werden sollen, 1 bis 5. Standard 3." },
      },
    },
    parse: (args) => {
      const limit = readPercent(args.limit);
      return limit === null ? {} : { limit: Math.max(1, Math.min(5, limit)) };
    },
  },
  {
    name: "gmail_search_mails",
    target: "local",
    path: "/gmail/search",
    label: "Mails suchen",
    description: "Sucht im Gmail-Postfach nach Absender, Betreff oder Stichwort, nach einem bestimmten Tag oder"
      + " nach beidem, und nennt die Treffer. Für „habe ich am 5. August Mails bekommen“ genügt date."
      + " Liest nur, schreibt nichts.",
    parameters: {
      type: "object",
      required: [],
      properties: {
        query: { type: "string", description: "Suchbegriff, zum Beispiel ein Absender oder ein Stichwort." },
        date: {
          type: "string",
          description: "Ein einzelner Tag, bevorzugt als JJJJ-MM-TT, zum Beispiel 2026-08-05."
            + " Auch heute, gestern, vorgestern oder ein Wochentag wie Freitag werden verstanden.",
        },
        limit: { type: "integer", description: "Wie viele Treffer genannt werden sollen, 1 bis 5. Standard 3." },
      },
    },
    parse: (args) => {
      const limit = readPercent(args.limit);
      return {
        query: readString(args.query, 200),
        date: readString(args.date, 40),
        ...(limit === null ? {} : { limit: Math.max(1, Math.min(5, limit)) }),
      };
    },
  },
  {
    name: "gmail_read_mail",
    target: "local",
    path: "/gmail/read",
    label: "Mail lesen",
    // The result is the text of the mail, not a finished sentence, so the model has to condense it.
    spoken: "model",
    description: "Verwenden, wenn der Nutzer wissen will, was in einer bestimmten Mail steht. Findet die Mail nach Absender, Betreff, Stichwort oder Datum und liefert ihren Text zur kurzen Zusammenfassung.",
    parameters: {
      type: "object",
      required: [],
      properties: {
        query: { type: "string", description: "Absender, Betreff oder Stichwort der gesuchten Mail." },
        date: { type: "string", description: "Optionaler Tag als JJJJ-MM-TT, heute oder gestern." },
      },
    },
    parse: (args) => ({
      query: readString(args.query, 200),
      date: readString(args.date, 40),
    }),
  },
  {
    name: "gmail_archive_mails",
    target: "local",
    path: "/gmail/archive",
    label: "Mails archivieren",
    description: "Nimmt die passenden E-Mails aus dem Posteingang. Sie bleiben unter Alle Nachrichten erhalten"
      + " und werden nicht gelöscht.",
    parameters: {
      type: "object",
      required: [],
      properties: {
        query: { type: "string", description: "Absender, Betreff oder Stichwort der betroffenen Mails." },
        date: { type: "string", description: "Optionaler Tag als JJJJ-MM-TT, heute oder gestern." },
      },
    },
    parse: (args) => ({
      query: readString(args.query, 200),
      date: readString(args.date, 40),
    }),
    confirmation: (args) => `Ich nehme ${mailScope(args)} aus dem Posteingang. Fortfahren?`,
  },
  {
    name: "gmail_trash_mails",
    target: "local",
    path: "/gmail/trash",
    label: "Mails in den Papierkorb",
    description: "Legt die passenden E-Mails in den Gmail-Papierkorb. Von dort sind sie 30 Tage lang"
      + " wiederherstellbar. Endgültig löschen kannst du nichts.",
    parameters: {
      type: "object",
      required: [],
      properties: {
        query: { type: "string", description: "Absender, Betreff oder Stichwort der betroffenen Mails." },
        date: { type: "string", description: "Optionaler Tag als JJJJ-MM-TT, heute oder gestern." },
      },
    },
    parse: (args) => ({
      query: readString(args.query, 200),
      date: readString(args.date, 40),
    }),
    confirmation: (args) => `Ich lege ${mailScope(args)} in den Papierkorb. Fortfahren?`,
  },
  {
    name: "chrome_search",
    target: "local",
    path: "/browser/search",
    label: "In Chrome suchen",
    description: "Verwenden nur, wenn der Nutzer ausdrücklich in Chrome oder im Web nach einem Begriff suchen beziehungsweise eine Suche öffnen will. Das Werkzeug liest die Ergebnisse nicht.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string", description: "Der Suchbegriff." } },
    },
    parse: (args) => ({ query: readString(args.query, 200) }),
  },
  {
    name: "chrome_open_url",
    target: "local",
    path: "/browser/open-url",
    label: "Seite öffnen",
    description: "Verwenden nur, wenn der Nutzer ausdrücklich eine bekannte Internetadresse oder Website in Chrome öffnen will, zum Beispiel wikipedia.org. Nicht für eine Informationsfrage verwenden.",
    parameters: {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string", description: "Die Adresse der Seite, zum Beispiel wikipedia.org." } },
    },
    parse: (args) => ({ url: readString(args.url, 400) }),
  },
];

const TOOLS_BY_NAME = new Map(ASSISTANT_TOOLS.map((tool) => [tool.name, tool]));

export function findAssistantTool(name: string) {
  return TOOLS_BY_NAME.get(name) ?? null;
}

/** The tool list in the shape Ollama expects for function calling. */
export function assistantToolDefinitions() {
  return ASSISTANT_TOOLS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function parseToolArguments(tool: AssistantTool, args: ToolArguments): ToolArguments {
  return tool.parse ? tool.parse(args) : {};
}

/** Returns the question an irreversible tool has to ask, or null when it may run directly. */
export function confirmationQuestion(tool: AssistantTool, args: ToolArguments) {
  return tool.confirmation ? tool.confirmation(args) : null;
}
