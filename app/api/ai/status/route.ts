import { NextResponse } from "next/server";
import { getLocalModelStatus } from "@/features/ai/server/ollama";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getLocalModelStatus();
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}
