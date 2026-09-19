import { NextResponse } from "next/server";
import { homedir } from "os";

export async function GET() {
  // The home directory has multiple consumers (session-manager store, file-explorer panel, editor move
  // dialog, ...) that each fetch it once; the home directory never changes within the process lifetime,
  // so a short private cache lets a second fetch on the same page hit the memory cache (no extra server hit).
  return NextResponse.json({ home: homedir() }, {
    headers: { "cache-control": "private, max-age=300" },
  });
}
