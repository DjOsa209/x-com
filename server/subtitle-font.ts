import { stat, copyFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { AppError } from "./errors.ts";
/** Explicit font loading also works with static FFmpeg builds without system font discovery. */
export async function subtitleFont(text: string) {
  const candidates: [string, string][] = process.env.SUBTITLE_FONT_FILE
    ? [
        [
          process.env.SUBTITLE_FONT_FILE,
          process.env.SUBTITLE_FONT_FAMILY || "Noto Sans CJK SC",
        ],
      ]
    : [
        ["/System/Library/Fonts/STHeiti Light.ttc", "Heiti SC"],
        ["/usr/share/fonts/noto/NotoSansCJK-Regular.ttc", "Noto Sans CJK SC"],
        [
          "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
          "Noto Sans CJK SC",
        ],
        [
          "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
          "Noto Sans CJK SC",
        ],
        ["C:/Windows/Fonts/msyh.ttc", "Microsoft YaHei"],
      ];
  for (const [file, family] of candidates) {
    if (!/^[\p{L}\p{N} _-]{1,80}$/u.test(family))
      throw new AppError(400, "字幕字体名称无效");
    try {
      if ((await stat(file)).isFile()) return { file, family };
    } catch {}
  }
  if (process.env.SUBTITLE_FONT_FILE || /\p{Script=Han}/u.test(text))
    throw new AppError(
      409,
      "中文字幕烧录需要中文字体，请配置 SUBTITLE_FONT_FILE 与 SUBTITLE_FONT_FAMILY，或使用带 Noto CJK 的 Docker 镜像",
      "SUBTITLE_FONT_MISSING",
    );
  return null;
}
export async function prepareSubtitleFont(folder: string, text: string) {
  const font = await subtitleFont(text);
  if (!font) return "Arial";
  const extension = extname(font.file).toLowerCase();
  if (![".ttf", ".ttc", ".otf", ".otc"].includes(extension))
    throw new AppError(400, "字幕字体须为 TTF/TTC/OTF 文件");
  await mkdir(join(folder, "fonts"), { recursive: true });
  await copyFile(font.file, join(folder, "fonts", "caption" + extension));
  return font.family;
}

export function subtitleAss(
  cues: { start: number; end: number; text: string }[],
  font: string,
  size: number,
  width: number,
  height: number,
) {
  const pixels = Math.max(12, Math.round((size * height) / 1280));
  const margin = Math.max(12, Math.round(width * 0.06));
  const maxUnits = (width - 2 * margin) / pixels;
  const units = (s: string) =>
    [...s].reduce(
      (n, c) =>
        n +
        (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(
          c,
        )
          ? 1
          : 0.55),
      0,
    );
  const wrap = (value: string) => {
    const lines: string[] = [];
    let line = "";
    const tokens = [
      ...new Intl.Segmenter("zh", { granularity: "word" }).segment(value),
    ].map((s) => s.segment);
    for (const token of tokens) {
      for (const part of token.split(/(\n)/)) {
        if (part === "\n") {
          lines.push(line.trim());
          line = "";
          continue;
        }
        if (units(line + part) > maxUnits && line.trim()) {
          lines.push(line.trim());
          line = "";
        }
        if (units(part) > maxUnits) {
          for (const c of part) {
            if (units(line + c) > maxUnits) {
              lines.push(line.trim());
              line = "";
            }
            line += c;
          }
        } else line += part;
      }
    }
    if (line.trim()) lines.push(line.trim());
    if (lines.length > 6)
      throw new AppError(400, "单条字幕过长，请按时间拆成多条字幕");
    return lines.join("\\N");
  };
  const stamp = (value: number) => {
    const total = Math.round(value * 100);
    return `${Math.floor(total / 360000)}:${String(Math.floor(total / 6000) % 60).padStart(2, "0")}:${String(Math.floor(total / 100) % 60).padStart(2, "0")}.${String(total % 100).padStart(2, "0")}`;
  };
  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},${pixels},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(pixels * 0.06))},0,2,${margin},${margin},${Math.round(height * 0.1)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    cues
      .map(
        (c) =>
          `Dialogue: 0,${stamp(c.start)},${stamp(c.end)},Default,,0,0,0,,${wrap(c.text)}`,
      )
      .join("\n") +
    "\n"
  );
}
