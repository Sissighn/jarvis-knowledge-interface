import { NextResponse } from "next/server";
import { SpeechModelError, transcribeAudio } from "@/features/speech/server/whisper";

export const dynamic = "force-dynamic";
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File) || !audio.type.startsWith("audio/")) {
      return NextResponse.json({ error: "Es wurde keine gültige Audioaufnahme übergeben." }, { status: 400 });
    }
    if (!audio.size || audio.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: "Die Audioaufnahme ist leer oder größer als 30 MB." }, { status: 413 });
    }

    return NextResponse.json(await transcribeAudio(audio), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Die lokale Transkription ist fehlgeschlagen.",
    }, { status: error instanceof SpeechModelError ? 503 : 500 });
  }
}
