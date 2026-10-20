export const mediaExtensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
};
export function validMediaHeader(b: Buffer, m: string) {
  return (
    (m === "image/png" &&
      b
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (m === "image/jpeg" && b[0] === 255 && b[1] === 216 && b[2] === 255) ||
    (m === "image/webp" &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP") ||
    (["video/mp4", "video/quicktime", "audio/mp4", "audio/x-m4a"].includes(m) &&
      b.toString("ascii", 4, 8) === "ftyp") ||
    (m === "video/webm" &&
      b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) ||
    (["audio/wav", "audio/x-wav"].includes(m) &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WAVE") ||
    (m === "audio/mpeg" &&
      (b.toString("ascii", 0, 3) === "ID3" ||
        (b[0] === 255 && (b[1] & 0xe0) === 0xe0)))
  );
}
