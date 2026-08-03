import { NextResponse } from "next/server";
import { getSpeechStatus } from "@/features/speech/server/whisper";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getSpeechStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
